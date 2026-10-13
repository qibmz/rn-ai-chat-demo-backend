import { HttpException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageRole } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { ChatAttachmentsService } from './chat-attachments.service.js';
import { ChatBillingService } from './chat-billing.service.js';
import { ChatStreamService } from './chat-stream.service.js';

const streamTextMock = vi.fn();
const pipeMock = vi.fn();
const toUIMessageStreamMock = vi.fn();
const createUIMessageStreamMock = vi.fn();
const createLanguageModelMock = vi.fn();

vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => streamTextMock(...args),
  pipeUIMessageStreamToResponse: (...args: unknown[]) => pipeMock(...args),
  toUIMessageStream: (...args: unknown[]) => toUIMessageStreamMock(...args),
  createUIMessageStream: (...args: unknown[]) =>
    createUIMessageStreamMock(...args),
}));

vi.mock('./llm/create-language-model.js', () => ({
  createLanguageModel: (...args: unknown[]) => createLanguageModelMock(...args),
}));

type UiStreamWriter = {
  write: ReturnType<typeof vi.fn>;
  merge: ReturnType<typeof vi.fn>;
};

type CreateUiStreamArgs = {
  execute: (args: { writer: UiStreamWriter }) => void;
  onEnd?: (args: {
    isAborted: boolean;
    responseMessage: { parts?: Array<{ type: string; text?: string }> };
  }) => void | Promise<void>;
};

describe('ChatStreamService', () => {
  let service: ChatStreamService;
  let prisma: {
    conversation: { findFirst: ReturnType<typeof vi.fn> };
    message: {
      findMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    attachment: {
      findMany: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let redis: {
    incr: ReturnType<typeof vi.fn>;
    decr: ReturnType<typeof vi.fn>;
  };
  let billing: {
    getWeeklySpendMicros: ReturnType<typeof vi.fn>;
    getWeeklyBudgetMicros: ReturnType<typeof vi.fn>;
    computeCostMicros: ReturnType<typeof vi.fn>;
    getPriceVersion: ReturnType<typeof vi.fn>;
    incrementWeeklySpend: ReturnType<typeof vi.fn>;
    recordSpend: ReturnType<typeof vi.fn>;
  };
  let txMessageCreate: ReturnType<typeof vi.fn>;
  let capturedOnEnd: CreateUiStreamArgs['onEnd'];
  let lastWriter: UiStreamWriter;

  const conversationId = 'bbbbbbbb-bbbb-4222-8222-bbbbbbbbbbbb';
  const userId = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedOnEnd = undefined;
    lastWriter = { write: vi.fn(), merge: vi.fn() };
    txMessageCreate = vi.fn().mockResolvedValue({});

    prisma = {
      conversation: {
        findFirst: vi.fn().mockResolvedValue({ id: conversationId }),
      },
      message: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
      },
      attachment: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          message: { create: txMessageCreate },
          attachment: { updateMany: vi.fn().mockResolvedValue({}) },
          conversation: { update: vi.fn().mockResolvedValue({}) },
        }),
      ),
    };

    redis = {
      incr: vi.fn().mockResolvedValue(1),
      decr: vi.fn().mockResolvedValue(0),
    };

    billing = {
      getWeeklySpendMicros: vi.fn().mockResolvedValue(0n),
      getWeeklyBudgetMicros: vi.fn().mockReturnValue(10_000_000n),
      computeCostMicros: vi.fn().mockReturnValue(0n),
      getPriceVersion: vi.fn().mockReturnValue('test'),
      incrementWeeklySpend: vi.fn().mockResolvedValue(undefined),
      recordSpend: vi.fn().mockResolvedValue(undefined),
    };

    createLanguageModelMock.mockReturnValue('language-model');

    createUIMessageStreamMock.mockImplementation((args: CreateUiStreamArgs) => {
      capturedOnEnd = args.onEnd;
      lastWriter = { write: vi.fn(), merge: vi.fn() };
      args.execute({ writer: lastWriter });
      return 'ui-stream';
    });

    streamTextMock.mockReturnValue({ stream: 'text-stream' });
    toUIMessageStreamMock.mockReturnValue('ui-message-stream');
    pipeMock.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatStreamService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string, fb?: string) => {
              const map: Record<string, string> = {
                CHAT_MAX_CONCURRENT_STREAMS: '2',
                CHAT_STREAM_LOCK_TTL_SEC: '1800',
                CHAT_MAX_USER_CHARS: '8000',
                CHAT_MAX_IMAGES_PER_MESSAGE: '3',
                CHAT_MAX_TOTAL_IMAGE_BYTES: '16777216',
                CHAT_THINKING_DEFAULT: 'true',
                CHAT_REASONING_EFFORT_DEFAULT: 'high',
                CHAT_MAX_TOKENS: '4096',
                CHAT_CONTEXT_MAX_TURNS: '20',
                CHAT_CONTEXT_MAX_CHARS: '32000',
                CHAT_CONTEXT_IMAGE_TURNS: '3',
                CHAT_IMAGE_DETAIL: 'low',
                CHAT_SYSTEM_PROMPT: '',
                LLM_PROVIDER: 'deepseek',
                LLM_BASE_URL: 'https://api.deepseek.com/v1',
                LLM_MODEL: 'deepseek-flash',
              };
              return map[key] ?? fb;
            }),
            getOrThrow: vi.fn((key: string) => {
              const map: Record<string, string> = {
                LLM_API_KEY: 'test-llm-key',
                LLM_BASE_URL: 'https://api.deepseek.com/v1',
                LLM_MODEL: 'deepseek-flash',
              };
              if (!(key in map)) {
                throw new Error(`missing config ${key}`);
              }
              return map[key];
            }),
          },
        },
        {
          provide: ChatAttachmentsService,
          useValue: { presignMany: vi.fn().mockResolvedValue(new Map()) },
        },
        { provide: ChatBillingService, useValue: billing },
      ],
    }).compile();

    service = module.get(ChatStreamService);
  });

  function mockRes(): Response {
    return {
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Response;
  }

  async function runHappyStream(
    overrides: {
      messages?: Array<{
        id?: string;
        role: string;
        content: string;
        parts: unknown;
        reasoningContent?: string | null;
        createdAt: Date;
      }>;
      thinking?: boolean;
      reasoningEffort?: 'low' | 'high' | 'max';
    } = {},
  ): Promise<void> {
    prisma.message.findMany.mockResolvedValue(
      overrides.messages ?? [
        {
          id: 'msg-user',
          role: 'user',
          content: 'hi',
          parts: [{ type: 'text', text: 'hi' }],
          createdAt: new Date(),
        },
      ],
    );

    await service.stream(
      userId,
      conversationId,
      {
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        thinking: overrides.thinking ?? true,
        reasoningEffort: overrides.reasoningEffort ?? 'high',
      },
      mockRes(),
    );
  }

  it('throws 404 when conversation missing', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(
      service.stream(
        userId,
        conversationId,
        {
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        },
        mockRes(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('throws 429 when concurrent streams exceeded', async () => {
    redis.incr.mockResolvedValue(3);
    await expect(
      service.stream(
        userId,
        conversationId,
        {
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        },
        mockRes(),
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(429);
      expect((err as HttpException).message).toBe(
        '当前对话请求过多，请稍后再试',
      );
      return true;
    });
    expect(redis.decr).toHaveBeenCalled();
    expect(pipeMock).not.toHaveBeenCalled();
  });

  it('streams with mocked AI SDK helpers', async () => {
    await runHappyStream();

    expect(createLanguageModelMock).toHaveBeenCalledWith({
      provider: 'deepseek',
      apiKey: 'test-llm-key',
      baseURL: 'https://api.deepseek.com/v1',
      modelId: 'deepseek-flash',
    });
    expect(streamTextMock).toHaveBeenCalled();
    expect(pipeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { 'X-Accel-Buffering': 'no' },
      }),
    );
    expect(redis.decr).toHaveBeenCalled();
  });

  it('writes data-chatMeta before merging UI stream', async () => {
    const writeOrder: string[] = [];
    createUIMessageStreamMock.mockImplementation((args: CreateUiStreamArgs) => {
      capturedOnEnd = args.onEnd;
      const writer: UiStreamWriter = {
        write: vi.fn((chunk: { type: string }) => {
          writeOrder.push(chunk.type);
        }),
        merge: vi.fn(() => {
          writeOrder.push('merge');
        }),
      };
      lastWriter = writer;
      args.execute({ writer });
      return 'ui-stream';
    });

    await runHappyStream();

    expect(writeOrder[0]).toBe('data-chatMeta');
    expect(writeOrder.indexOf('data-chatMeta')).toBeLessThan(
      writeOrder.indexOf('merge'),
    );
    expect(lastWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'data-chatMeta',
        data: expect.objectContaining({
          userMessageId: expect.any(String),
          assistantMessageId: expect.any(String),
          quota: null,
        }),
      }),
    );
  });

  it('persists once on onEnd abort with finishReason=aborted', async () => {
    await runHappyStream();

    expect(capturedOnEnd).toEqual(expect.any(Function));

    await capturedOnEnd?.({
      isAborted: true,
      responseMessage: { parts: [{ type: 'text', text: '半截' }] },
    });

    expect(billing.recordSpend).toHaveBeenCalledTimes(1);
    expect(billing.incrementWeeklySpend).toHaveBeenCalledTimes(1);

    const assistantCreates = txMessageCreate.mock.calls.filter(
      (call) => call[0]?.data?.role === MessageRole.assistant,
    );
    expect(assistantCreates).toHaveLength(1);
    expect(assistantCreates[0]?.[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          role: MessageRole.assistant,
          content: '半截',
          finishReason: 'aborted',
        }),
      }),
    );

    await capturedOnEnd?.({
      isAborted: true,
      responseMessage: { parts: [{ type: 'text', text: '半截' }] },
    });

    expect(billing.recordSpend).toHaveBeenCalledTimes(1);
    expect(billing.incrementWeeklySpend).toHaveBeenCalledTimes(1);
    expect(
      txMessageCreate.mock.calls.filter(
        (call) => call[0]?.data?.role === MessageRole.assistant,
      ),
    ).toHaveLength(1);
  });

  it('persists once on onEnd success using onFinish usage', async () => {
    const costMicros = 12_345n;
    billing.computeCostMicros.mockReturnValue(costMicros);

    await runHappyStream();

    const streamTextArgs = streamTextMock.mock.calls[0]?.[0] as {
      onFinish?: (args: { usage: unknown }) => void;
    };
    expect(streamTextArgs.onFinish).toEqual(expect.any(Function));
    expect(capturedOnEnd).toEqual(expect.any(Function));

    const usage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      inputTokenDetails: {
        cacheReadTokens: 20,
        noCacheTokens: 80,
      },
      outputTokenDetails: {
        textTokens: 40,
        reasoningTokens: 10,
      },
    };
    streamTextArgs.onFinish?.({ usage });

    await capturedOnEnd?.({
      isAborted: false,
      responseMessage: { parts: [{ type: 'text', text: '完整回答' }] },
    });

    const expectedMappedUsage = {
      promptTokens: 100,
      totalTokens: 150,
      promptCacheHitTokens: 20,
      promptCacheMissTokens: 80,
      completionTokens: 40,
      reasoningTokens: 10,
    };

    expect(billing.computeCostMicros).toHaveBeenCalledWith(expectedMappedUsage);
    expect(billing.incrementWeeklySpend).toHaveBeenCalledTimes(1);
    expect(billing.incrementWeeklySpend).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      costMicros,
    );
    expect(billing.recordSpend).toHaveBeenCalledTimes(1);
    expect(billing.recordSpend).toHaveBeenCalledWith(userId, costMicros);

    const assistantCreates = txMessageCreate.mock.calls.filter(
      (call) => call[0]?.data?.role === MessageRole.assistant,
    );
    expect(assistantCreates).toHaveLength(1);
    expect(assistantCreates[0]?.[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          role: MessageRole.assistant,
          content: '完整回答',
          finishReason: 'stop',
          promptTokens: 100,
          completionTokens: 40,
          totalTokens: 150,
          promptCacheHitTokens: 20,
          promptCacheMissTokens: 80,
          reasoningTokens: 10,
          costMicros,
        }),
      }),
    );

    await capturedOnEnd?.({
      isAborted: false,
      responseMessage: { parts: [{ type: 'text', text: '完整回答' }] },
    });

    expect(billing.recordSpend).toHaveBeenCalledTimes(1);
    expect(billing.incrementWeeklySpend).toHaveBeenCalledTimes(1);
    expect(billing.computeCostMicros).toHaveBeenCalledTimes(1);
    expect(
      txMessageCreate.mock.calls.filter(
        (call) => call[0]?.data?.role === MessageRole.assistant,
      ),
    ).toHaveLength(1);
  });

  it('buildModelMessages does not put historical reasoning into model messages', async () => {
    const secretCot = 'SECRET_COT_SHOULD_NOT_APPEAR';
    await runHappyStream({
      messages: [
        {
          id: 'msg-asst',
          role: 'assistant',
          content: '可见回复',
          parts: [{ type: 'text', text: '可见回复' }],
          reasoningContent: secretCot,
          createdAt: new Date('2020-01-01T00:00:00.000Z'),
        },
        {
          id: 'msg-user',
          role: 'user',
          content: 'hi',
          parts: [{ type: 'text', text: 'hi' }],
          createdAt: new Date('2020-01-02T00:00:00.000Z'),
        },
      ],
    });

    expect(streamTextMock).toHaveBeenCalled();
    const { messages } = streamTextMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('可见回复');
    expect(JSON.stringify(messages)).not.toContain(secretCot);
  });
});
