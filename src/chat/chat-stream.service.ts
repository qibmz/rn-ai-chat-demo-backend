import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageRole, Prisma } from '@prisma/client';
import {
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  streamText,
  toUIMessageStream,
  type LanguageModelUsage,
  type ModelMessage,
} from 'ai';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { ChatAttachmentsService } from './chat-attachments.service.js';
import { ChatBillingService } from './chat-billing.service.js';
import { StreamMessagesDto } from './dto/stream-messages.dto.js';
import { createLanguageModel } from './llm/create-language-model.js';
import { extractUiMessageText } from './llm/extract-ui-message-text.js';
import {
  mapLanguageModelUsage,
  type MappedLlmUsage,
} from './llm/map-language-model-usage.js';
import { streamLockRedisKey } from './utils/chat-billing.util.js';

type StoredPart =
  { type: 'text'; text: string } | { type: 'image'; attachmentId: string };

type DbMessage = {
  id: string;
  role: MessageRole;
  content: string;
  parts: Prisma.JsonValue;
  createdAt: Date;
};

@Injectable()
export class ChatStreamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
    private readonly attachments: ChatAttachmentsService,
    private readonly billing: ChatBillingService,
  ) {}

  async stream(
    userId: string,
    conversationId: string,
    dto: StreamMessagesDto,
    res: Response,
  ): Promise<void> {
    const { systemPrompt: botSystemPrompt } = await this.assertConversation(
      userId,
      conversationId,
    );

    const maxConcurrent = Number(
      this.configService.get('CHAT_MAX_CONCURRENT_STREAMS', '2'),
    );
    const lockTtl = Number(
      this.configService.get('CHAT_STREAM_LOCK_TTL_SEC', '1800'),
    );
    const lockKey = streamLockRedisKey(userId);

    const concurrent = await this.redis.incr(lockKey, lockTtl);
    if (concurrent > maxConcurrent) {
      await this.redis.decr(lockKey);
      throw new HttpException(
        '当前对话请求过多，请稍后再试',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    let lockHeld = true;
    try {
      const spend = await this.billing.getWeeklySpendMicros(userId);
      const budget = this.billing.getWeeklyBudgetMicros();
      if (budget > 0n && spend >= budget) {
        throw new HttpException(
          '本周对话额度已用完',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      const userText = this.extractLastUserText(dto.messages);
      const attachmentIds = [...new Set(dto.attachmentIds ?? [])];
      this.validateUserLimits(userText, attachmentIds.length);

      const attachmentRows = await this.loadUserAttachments(
        userId,
        attachmentIds,
      );
      this.validateImageBytes(attachmentRows);

      const thinking = this.resolveThinking(dto.thinking);
      const reasoningEffort = this.resolveReasoningEffort(dto.reasoningEffort);

      const userParts: StoredPart[] = [{ type: 'text', text: userText }];
      for (const id of attachmentIds) {
        userParts.push({ type: 'image', attachmentId: id });
      }

      const userMessageId = randomUUID();
      const assistantMessageId = randomUUID();

      await this.prisma.$transaction(async (tx) => {
        await tx.message.create({
          data: {
            id: userMessageId,
            conversationId,
            role: MessageRole.user,
            content: userText,
            parts: userParts as unknown as Prisma.InputJsonValue,
            thinkingEnabled: thinking,
            reasoningEffort: thinking ? reasoningEffort : null,
          },
        });

        if (attachmentIds.length > 0) {
          await tx.attachment.updateMany({
            where: {
              id: { in: attachmentIds },
              userId,
              messageId: null,
            },
            data: { messageId: userMessageId },
          });
        }

        await tx.conversation.update({
          where: { id: conversationId },
          data: { updatedAt: new Date() },
        });
      });

      const modelMessages = await this.buildModelMessages(
        userId,
        conversationId,
        botSystemPrompt,
      );

      const abortController = new AbortController();
      const onClose = () => {
        abortController.abort();
      };
      res.on('close', onClose);

      const apiKey = this.configService.getOrThrow<string>('LLM_API_KEY');
      const baseURL = this.configService.getOrThrow<string>('LLM_BASE_URL');
      const modelId = this.configService.getOrThrow<string>('LLM_MODEL');
      const provider =
        this.configService.get<string>('LLM_PROVIDER')?.trim() || 'deepseek';
      const maxOutputTokens = Number(
        this.configService.get('CHAT_MAX_TOKENS', '4096'),
      );

      const model = createLanguageModel({
        provider,
        apiKey,
        baseURL,
        modelId,
      });

      let lastUsage: LanguageModelUsage | undefined;
      let persisted = false;

      const persistOnce = async (args: {
        text: string;
        reasoningText: string | null;
        finishReason: string | null;
      }) => {
        if (persisted) {
          return;
        }
        persisted = true;
        const mapped = mapLanguageModelUsage(lastUsage);
        await this.persistAssistantMessage({
          assistantMessageId,
          conversationId,
          text: args.text,
          reasoningText: args.reasoningText,
          thinking,
          reasoningEffort: thinking ? reasoningEffort : null,
          finishReason: args.finishReason,
          usage: mapped,
          userId,
        });
      };

      try {
        const stream = createUIMessageStream({
          execute: ({ writer }) => {
            writer.write({
              type: 'data-chatMeta',
              data: {
                userMessageId,
                assistantMessageId,
                quota: null,
              },
            });

            const result = streamText({
              model,
              messages: modelMessages,
              maxOutputTokens,
              abortSignal: abortController.signal,
              providerOptions: {
                deepseek: {
                  thinking: { type: thinking ? 'enabled' : 'disabled' },
                  ...(thinking ? { reasoningEffort } : {}),
                  userId:
                    userId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 512) ||
                    'anonymous',
                },
              },
              onFinish: ({ usage }) => {
                lastUsage = usage;
              },
            });

            writer.merge(
              toUIMessageStream({
                stream: result.stream,
                sendReasoning: thinking,
                generateMessageId: () => assistantMessageId,
                onError: (error) =>
                  error instanceof Error ? error.message : String(error),
              }),
            );
          },
          onEnd: async ({ isAborted, responseMessage }) => {
            const { text, reasoningText } =
              extractUiMessageText(responseMessage);
            await persistOnce({
              text,
              reasoningText,
              finishReason: isAborted ? 'aborted' : 'stop',
            });
          },
          onError: (error) =>
            error instanceof Error ? error.message : String(error),
          generateId: () => assistantMessageId,
        });

        await pipeUIMessageStreamToResponse({
          response: res,
          stream,
          headers: {
            'X-Accel-Buffering': 'no',
          },
        });
      } finally {
        res.off('close', onClose);
      }
    } finally {
      if (lockHeld) {
        lockHeld = false;
        try {
          await this.redis.decr(lockKey);
        } catch {
          // ignore unlock failures
        }
      }
    }
  }

  private async assertConversation(
    userId: string,
    conversationId: string,
  ): Promise<{ systemPrompt: string | null }> {
    const row = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userId, deletedAt: null },
      select: {
        id: true,
        bot: { select: { systemPrompt: true, deletedAt: true } },
      },
    });
    if (!row || row.bot?.deletedAt) {
      throw new NotFoundException('对话不存在');
    }
    return { systemPrompt: row.bot?.systemPrompt ?? null };
  }

  private extractLastUserText(messages: StreamMessagesDto['messages']): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg?.role !== 'user') {
        continue;
      }
      const parts = msg.parts ?? [];
      const text = parts
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('');
      return text;
    }
    throw new HttpException('缺少用户消息', HttpStatus.BAD_REQUEST);
  }

  private validateUserLimits(text: string, imageCount: number): void {
    const maxChars = Number(
      this.configService.get('CHAT_MAX_USER_CHARS', '8000'),
    );
    if (text.length > maxChars) {
      throw new PayloadTooLargeException('用户消息过长');
    }

    const maxImages = Number(
      this.configService.get('CHAT_MAX_IMAGES_PER_MESSAGE', '3'),
    );
    if (imageCount > maxImages) {
      throw new PayloadTooLargeException('单条消息图片数量超出限制');
    }
  }

  private async loadUserAttachments(
    userId: string,
    attachmentIds: string[],
  ): Promise<Array<{ id: string; byteSize: number; mimeType: string }>> {
    if (attachmentIds.length === 0) {
      return [];
    }
    const rows = await this.prisma.attachment.findMany({
      where: { id: { in: attachmentIds }, userId },
      select: { id: true, byteSize: true, mimeType: true },
    });
    if (rows.length !== attachmentIds.length) {
      throw new NotFoundException('附件不存在');
    }
    return rows;
  }

  private validateImageBytes(rows: Array<{ byteSize: number }>): void {
    const maxTotal = Number(
      this.configService.get('CHAT_MAX_TOTAL_IMAGE_BYTES', '16777216'),
    );
    const total = rows.reduce((sum, r) => sum + r.byteSize, 0);
    if (total > maxTotal) {
      throw new PayloadTooLargeException('图片总大小超出限制');
    }
  }

  private resolveThinking(thinking?: boolean): boolean {
    if (typeof thinking === 'boolean') {
      return thinking;
    }
    const def = this.configService.get('CHAT_THINKING_DEFAULT', 'true');
    return String(def).toLowerCase() !== 'false';
  }

  private resolveReasoningEffort(
    effort?: 'low' | 'high' | 'max',
  ): 'low' | 'high' | 'max' {
    if (effort) {
      return effort;
    }
    const def = this.configService.get('CHAT_REASONING_EFFORT_DEFAULT', 'high');
    if (def === 'low' || def === 'max') {
      return def;
    }
    return 'high';
  }

  private async buildModelMessages(
    userId: string,
    conversationId: string,
    botSystemPrompt: string | null,
  ): Promise<ModelMessage[]> {
    const maxTurns = Number(
      this.configService.get('CHAT_CONTEXT_MAX_TURNS', '20'),
    );
    const maxChars = Number(
      this.configService.get('CHAT_CONTEXT_MAX_CHARS', '32000'),
    );
    const imageTurns = Number(
      this.configService.get('CHAT_CONTEXT_IMAGE_TURNS', '3'),
    );
    const imageDetail = this.configService.get<string>(
      'CHAT_IMAGE_DETAIL',
      'low',
    );
    const globalPrompt =
      this.configService.get<string>('CHAT_SYSTEM_PROMPT', '')?.trim() ?? '';
    const trimmedBot = botSystemPrompt?.trim() ?? '';
    const systemPrompt = trimmedBot || globalPrompt;

    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: Math.max(maxTurns * 2, maxTurns),
    });
    const chronological = [...rows].reverse() as DbMessage[];

    // Keep last maxTurns messages within char budget (from the end).
    const selected: DbMessage[] = [];
    let charCount = 0;
    for (let i = chronological.length - 1; i >= 0; i -= 1) {
      if (selected.length >= maxTurns) {
        break;
      }
      const msg = chronological[i]!;
      const next = charCount + (msg.content?.length ?? 0);
      if (selected.length > 0 && next > maxChars) {
        break;
      }
      selected.unshift(msg);
      charCount = next;
    }

    let userTurnsFromEnd = 0;
    const allowImagesFor = new Set<string>();
    for (let i = selected.length - 1; i >= 0; i -= 1) {
      const msg = selected[i]!;
      if (msg.role === MessageRole.user) {
        userTurnsFromEnd += 1;
        if (userTurnsFromEnd <= imageTurns) {
          allowImagesFor.add(msg.id);
        }
      }
    }

    const imageIds: string[] = [];
    for (const msg of selected) {
      if (!allowImagesFor.has(msg.id)) {
        continue;
      }
      for (const part of this.parseParts(msg.parts)) {
        if (part.type === 'image') {
          imageIds.push(part.attachmentId);
        }
      }
    }
    const presigned = await this.attachments.presignMany(userId, imageIds);

    const messages: ModelMessage[] = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of selected) {
      if (msg.role === MessageRole.system) {
        messages.push({ role: 'system', content: msg.content });
        continue;
      }
      if (msg.role === MessageRole.assistant) {
        // Visible content only — never attach historical reasoningContent.
        messages.push({ role: 'assistant', content: msg.content });
        continue;
      }

      const parts = this.parseParts(msg.parts);
      const content: Array<
        | { type: 'text'; text: string }
        | {
            type: 'image';
            image: string;
            mediaType?: string;
            providerOptions?: {
              deepseek: {
                imageDetail: 'low' | 'high' | 'original' | 'auto';
              };
            };
          }
      > = [];

      for (const part of parts) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text });
          continue;
        }
        if (part.type === 'image' && allowImagesFor.has(msg.id)) {
          const info = presigned.get(part.attachmentId);
          if (!info) {
            continue;
          }
          const detail =
            imageDetail === 'high' ||
            imageDetail === 'original' ||
            imageDetail === 'auto'
              ? imageDetail
              : 'low';
          content.push({
            type: 'image',
            image: info.url,
            mediaType: info.mimeType,
            providerOptions: {
              deepseek: { imageDetail: detail },
            },
          });
        }
      }

      if (content.length === 0) {
        content.push({ type: 'text', text: msg.content || '' });
      }

      messages.push({
        role: 'user',
        content:
          content.length === 1 && content[0]?.type === 'text'
            ? content[0].text
            : content,
      });
    }

    return messages;
  }

  private parseParts(parts: Prisma.JsonValue): StoredPart[] {
    if (!Array.isArray(parts)) {
      return [];
    }
    const out: StoredPart[] = [];
    for (const raw of parts) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const part = raw as {
        type?: string;
        text?: string;
        attachmentId?: string;
      };
      if (part.type === 'text' && typeof part.text === 'string') {
        out.push({ type: 'text', text: part.text });
      } else if (
        part.type === 'image' &&
        typeof part.attachmentId === 'string'
      ) {
        out.push({ type: 'image', attachmentId: part.attachmentId });
      }
    }
    return out;
  }

  private async persistAssistantMessage(args: {
    assistantMessageId: string;
    conversationId: string;
    text: string;
    reasoningText: string | null;
    thinking: boolean;
    reasoningEffort: string | null;
    finishReason: string | null;
    usage: MappedLlmUsage;
    userId: string;
  }): Promise<void> {
    const billed = args.usage;
    const costMicros = this.billing.computeCostMicros(billed);
    const priceVersion = this.billing.getPriceVersion();

    await this.prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          id: args.assistantMessageId,
          conversationId: args.conversationId,
          role: MessageRole.assistant,
          content: args.text,
          parts: [
            { type: 'text', text: args.text },
          ] as unknown as Prisma.InputJsonValue,
          reasoningContent: args.reasoningText,
          thinkingEnabled: args.thinking,
          reasoningEffort: args.reasoningEffort,
          finishReason: args.finishReason,
          promptTokens: billed.promptTokens,
          completionTokens: billed.completionTokens,
          totalTokens: billed.totalTokens,
          promptCacheHitTokens: billed.promptCacheHitTokens,
          promptCacheMissTokens: billed.promptCacheMissTokens,
          reasoningTokens: billed.reasoningTokens ?? 0,
          costMicros,
          priceVersion,
        },
      });
      await tx.conversation.update({
        where: { id: args.conversationId },
        data: { updatedAt: new Date() },
      });
      await this.billing.incrementWeeklySpend(tx, args.userId, costMicros);
    });

    await this.billing.recordSpend(args.userId, costMicros);
  }
}
