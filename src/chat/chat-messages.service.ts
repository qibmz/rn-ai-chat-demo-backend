import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChatAttachmentsService } from './chat-attachments.service.js';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto.js';

type RawPart = {
  type?: string;
  text?: string;
  attachmentId?: string;
};

export type EnrichedPart =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      attachmentId: string;
      mimeType: string;
      byteSize: number;
      url: string;
    }
  | RawPart;

export type MessageDto = {
  id: string;
  role: string;
  content: string;
  parts: EnrichedPart[];
  createdAt: string;
};

export type MessagesPageDto = {
  items: MessageDto[];
  hasMore: boolean;
};

@Injectable()
export class ChatMessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: ChatAttachmentsService,
  ) {}

  private async assertConversation(userId: string, conversationId: string) {
    const row = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userId, deletedAt: null },
    });
    if (!row) {
      throw new NotFoundException('对话不存在');
    }
    return row;
  }

  private collectAttachmentIds(parts: RawPart[]): string[] {
    const ids: string[] = [];
    for (const part of parts) {
      if (part.type === 'image' && part.attachmentId) {
        ids.push(part.attachmentId);
      }
    }
    return ids;
  }

  private enrichParts(
    parts: RawPart[],
    presigned: Map<string, { url: string; mimeType: string; byteSize: number }>,
  ): EnrichedPart[] {
    return parts.map((part) => {
      if (part.type === 'text') {
        return { type: 'text' as const, text: part.text ?? '' };
      }
      if (part.type === 'image' && part.attachmentId) {
        const info = presigned.get(part.attachmentId);
        if (info) {
          return {
            type: 'image' as const,
            attachmentId: part.attachmentId,
            mimeType: info.mimeType,
            byteSize: info.byteSize,
            url: info.url,
          };
        }
      }
      return part;
    });
  }

  async list(
    userId: string,
    conversationId: string,
    query: ListMessagesQueryDto,
  ): Promise<MessagesPageDto> {
    await this.assertConversation(userId, conversationId);

    const limit = query.limit ?? 50;
    const where: Prisma.MessageWhereInput = { conversationId };

    if (query.before) {
      const cursor = await this.prisma.message.findFirst({
        where: { id: query.before, conversationId },
      });
      if (!cursor) {
        throw new NotFoundException('对话不存在');
      }
      where.createdAt = { lt: cursor.createdAt };
    }

    const rows = await this.prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const ordered = [...slice].reverse();

    const attachmentIds = ordered.flatMap((m) =>
      this.collectAttachmentIds(m.parts as RawPart[]),
    );
    const presigned = await this.attachments.presignMany(userId, attachmentIds);
    const presignMap = new Map(
      [...presigned.entries()].map(([id, p]) => [
        id,
        { url: p.url, mimeType: p.mimeType, byteSize: p.byteSize },
      ]),
    );

    const items: MessageDto[] = ordered.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      parts: this.enrichParts(m.parts as RawPart[], presignMap),
      createdAt: m.createdAt.toISOString(),
    }));

    return { items, hasMore };
  }
}
