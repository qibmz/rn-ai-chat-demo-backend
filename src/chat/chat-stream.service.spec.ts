import { HttpException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
const createOpenAIMock = vi.fn();

vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => streamTextMock(...args),
  pipeUIMessageStreamToResponse: (...args: unknown[]) => pipeMock(...args),
  toUIMessageStream: (...args: unknown[]) => toUIMessageStreamMock(...args),
  createUIMessageStream: (...args: unknown[]) =>
    createUIMessageStreamMock(...args),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: (...args: unknown[]) => createOpenAIMock(...args),
}));

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

  const conversationId = 'bbbbbbbb-bbbb-4222-8222-bbbbbbbbbbbb';
  const userId = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    vi.clearAllMocks();

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
          message: { create: vi.fn().mockResolvedValue({}) },
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

    createOpenAIMock.mockReturnValue({
      chat: vi.fn().mockReturnValue('model'),
    });

    createUIMessageStreamMock.mockImplementation(
      ({
        execute,
      }: {
        execute: (args: {
          writer: {
            write: ReturnType<typeof vi.fn>;
            merge: ReturnType<typeof vi.fn>;
          };
        }) => void;
      }) => {
        const writer = { write: vi.fn(), merge: vi.fn() };
        execute({ writer });
        return 'ui-stream';
      },
    );

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
                DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
                DEEPSEEK_MODEL: 'deepseek-flash',
              };
              return map[key] ?? fb;
            }),
            getOrThrow: vi.fn(() => 'test-deepseek-key'),
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
    ).rejects.toMatchObject({
      status: 429,
      message: '当前对话请求过多，请稍后再试',
    } satisfies Partial<HttpException>);
    expect(redis.decr).toHaveBeenCalled();
    expect(pipeMock).not.toHaveBeenCalled();
  });

  it('streams with mocked AI SDK helpers', async () => {
    // After user message persist, context load should include it
    prisma.message.findMany.mockResolvedValue([
      {
        id: 'msg-user',
        role: 'user',
        content: 'hi',
        parts: [{ type: 'text', text: 'hi' }],
        createdAt: new Date(),
      },
    ]);

    await service.stream(
      userId,
      conversationId,
      {
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        thinking: true,
        reasoningEffort: 'high',
      },
      mockRes(),
    );

    expect(streamTextMock).toHaveBeenCalled();
    expect(pipeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { 'X-Accel-Buffering': 'no' },
      }),
    );
    expect(redis.decr).toHaveBeenCalled();
  });
});
