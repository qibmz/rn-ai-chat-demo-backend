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
import { ChatModelFactory } from './llm/chat-model.factory.js';
import { DeepSeekToolsClient } from './llm/deepseek-tools.client.js';

const streamTextMock = vi.fn();
const pipeMock = vi.fn();
const toUIMessageStreamMock = vi.fn();
const createUIMessageStreamMock = vi.fn();
const createLanguageModelMock = vi.fn();
const createWebToolsMock = vi.fn();

vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => streamTextMock(...args),
  pipeUIMessageStreamToResponse: (...args: unknown[]) => pipeMock(...args),
  toUIMessageStream: (...args: unknown[]) => toUIMessageStreamMock(...args),
  createUIMessageStream: (...args: unknown[]) =>
    createUIMessageStreamMock(...args),
  isStepCount: (n: number) => ({ __stopWhen: 'isStepCount', n }),
  tool: vi.fn((def: unknown) => def),
  jsonSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock('./llm/create-web-tools.js', () => ({
  createWebTools: (...args: unknown[]) => createWebToolsMock(...args),
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
    computeWebToolsCostMicros: ReturnType<typeof vi.fn>;
    getWebToolPrices: ReturnType<typeof vi.fn>;
  };
  let webSession: {
    billableSearchCount: number;
    billableFetchCount: number;
    sources: Array<{
      title: string;
      url: string;
      snippet: string;
      siteName?: string | null;
      fetched?: boolean;
    }>;
  };
  let toolsClient: {
    search: ReturnType<typeof vi.fn>;
    fetchPage: ReturnType<typeof vi.fn>;
  };
  let txMessageCreate: ReturnType<typeof vi.fn>;
  let capturedOnEnd: CreateUiStreamArgs['onEnd'];
  let lastWriter: UiStreamWriter;
  let configMap: Record<string, string>;

  const conversationId = 'bbbbbbbb-bbbb-4222-8222-bbbbbbbbbbbb';
  const userId = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedOnEnd = undefined;
    lastWriter = { write: vi.fn(), merge: vi.fn() };
    txMessageCreate = vi.fn().mockResolvedValue({});
    configMap = {
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
      CHAT_SYSTEM_PROMPT: '全局默认',
      LLM_PROVIDER: 'deepseek',
      LLM_BASE_URL: 'https://api.deepseek.com/v1',
      LLM_MODEL: 'deepseek-flash',
    };

    prisma = {
      conversation: {
        findFirst: vi.fn().mockResolvedValue({
          id: conversationId,
          bot: { systemPrompt: null, deletedAt: null },
        }),
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
      computeWebToolsCostMicros: vi.fn().mockReturnValue(0n),
      getWebToolPrices: vi
        .fn()
        .mockReturnValue({ search: 5000n, fetch: 5000n }),
    };

    webSession = {
      billableSearchCount: 0,
      billableFetchCount: 0,
      sources: [],
    };
    createWebToolsMock.mockImplementation(() => ({
      tools: {
        web_search: { name: 'web_search' },
        web_fetch: { name: 'web_fetch' },
      },
      session: webSession,
    }));

    toolsClient = {
      search: vi.fn(),
      fetchPage: vi.fn(),
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
            get: vi.fn((key: string, fb?: string) => configMap[key] ?? fb),
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
        {
          provide: ChatModelFactory,
          useValue: { create: createLanguageModelMock },
        },
        { provide: DeepSeekToolsClient, useValue: toolsClient },
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

  it('throws 404 when conversation bot is soft-deleted', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: conversationId,
      bot: { systemPrompt: '你是日程助手', deletedAt: new Date() },
    });
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

  it('uses Bot systemPrompt as first system message when non-empty', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: conversationId,
      bot: { systemPrompt: '你是日程助手', deletedAt: null },
    });

    await runHappyStream();

    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'system', content: '你是日程助手' }),
        ]),
      }),
    );
    const botPromptCall = streamTextMock.mock.calls[0];
    expect(botPromptCall).toBeDefined();
    const { messages } = botPromptCall![0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(messages[0]).toEqual({ role: 'system', content: '你是日程助手' });
    expect(messages[0]?.content).not.toBe('全局默认');
    expect(JSON.stringify(messages)).not.toContain('全局默认');
  });

  it('falls back to CHAT_SYSTEM_PROMPT when Bot systemPrompt empty', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: conversationId,
      bot: { systemPrompt: '   ', deletedAt: null },
    });

    await runHappyStream();

    const emptyBotCall = streamTextMock.mock.calls[0];
    expect(emptyBotCall).toBeDefined();
    const { messages } = emptyBotCall![0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(messages[0]).toEqual({ role: 'system', content: '全局默认' });
  });

  it('keeps historical role=system messages after prepended system', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: conversationId,
      bot: { systemPrompt: '你是日程助手', deletedAt: null },
    });

    await runHappyStream({
      messages: [
        {
          id: 'msg-sys',
          role: 'system',
          content: '历史系统补充',
          parts: [{ type: 'text', text: '历史系统补充' }],
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

    const historySysCall = streamTextMock.mock.calls[0];
    expect(historySysCall).toBeDefined();
    const { messages } = historySysCall![0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(messages[0]).toEqual({ role: 'system', content: '你是日程助手' });
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system', content: '历史系统补充' }),
      ]),
    );
    expect(
      messages.findIndex((m) => m.content === '你是日程助手'),
    ).toBeLessThan(messages.findIndex((m) => m.content === '历史系统补充'));
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

  function lastModelMessages(): Array<{ role: string; content: unknown }> {
    const call = streamTextMock.mock.calls.at(-1);
    expect(call).toBeDefined();
    return (call![0] as { messages: Array<{ role: string; content: unknown }> })
      .messages;
  }

  it('passes stopWhen isStepCount and the same tools to the UI stream', async () => {
    await runHappyStream();

    const streamArgs = streamTextMock.mock.calls[0]?.[0] as {
      stopWhen?: { __stopWhen?: string; n?: number };
      tools?: Record<string, unknown>;
      maxOutputTokens?: number;
    };
    expect(streamArgs.stopWhen).toEqual({ __stopWhen: 'isStepCount', n: 8 });
    expect(streamArgs.maxOutputTokens).toBe(2048);
    expect(streamArgs.tools).toEqual(
      expect.objectContaining({
        web_search: expect.anything(),
        web_fetch: expect.anything(),
      }),
    );
    const uiArgs = toUIMessageStreamMock.mock.calls[0]?.[0] as {
      tools?: unknown;
    };
    expect(uiArgs.tools).toBe(streamArgs.tools);
    expect(createWebToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        client: toolsClient,
        userText: 'hi',
        oriQuestion: 'hi',
        config: {
          searchMaxPerTurn: 2,
          fetchMaxPerTurn: 3,
          searchDefaultCount: 10,
          searchCountCap: 10,
          fetchMaxChars: 8000,
        },
      }),
    );
  });

  it('uses CHAT_WEB_TOOL_MAX_STEPS for isStepCount', async () => {
    configMap.CHAT_WEB_TOOL_MAX_STEPS = '3';
    configMap.CHAT_WEB_STEP_MAX_TOKENS = '512';

    await runHappyStream();

    const streamArgs = streamTextMock.mock.calls[0]?.[0] as {
      stopWhen?: { n?: number };
      maxOutputTokens?: number;
    };
    expect(streamArgs.stopWhen).toEqual({ __stopWhen: 'isStepCount', n: 3 });
    expect(streamArgs.maxOutputTokens).toBe(512);
  });

  it('includes historical reasoning for recent CoT turns', async () => {
    const secretCot = 'SECRET_COT_SHOULD_APPEAR';
    await runHappyStream({
      messages: [
        {
          id: 'msg-user',
          role: 'user',
          content: 'hi',
          parts: [{ type: 'text', text: 'hi' }],
          createdAt: new Date('2020-01-02T00:00:00.000Z'),
        },
        {
          id: 'msg-asst',
          role: 'assistant',
          content: '可见回复',
          parts: [{ type: 'text', text: '可见回复' }],
          reasoningContent: secretCot,
          createdAt: new Date('2020-01-01T00:00:00.000Z'),
        },
      ],
    });

    const assistant = lastModelMessages().find((m) => m.role === 'assistant');
    expect(assistant?.content).toEqual([
      { type: 'reasoning', text: secretCot },
      { type: 'text', text: '可见回复' },
    ]);
  });

  it('drops CoT outside the history turn limit and truncates over-long CoT', async () => {
    configMap.CHAT_WEB_REASONING_HISTORY_TURNS = '1';
    configMap.CHAT_WEB_REASONING_MAX_CHARS = '2';
    const oldCot = 'OLD_COT_FULL_TEXT';
    const recentCot = '你好世界';

    await runHappyStream({
      messages: [
        {
          id: 'msg-user',
          role: 'user',
          content: 'hi',
          parts: [{ type: 'text', text: 'hi' }],
          createdAt: new Date('2020-01-04T00:00:00.000Z'),
        },
        {
          id: 'msg-recent',
          role: 'assistant',
          content: '新回复',
          parts: [{ type: 'text', text: '新回复' }],
          reasoningContent: recentCot,
          createdAt: new Date('2020-01-03T00:00:00.000Z'),
        },
        {
          id: 'msg-middle',
          role: 'assistant',
          content: '无思维',
          parts: [{ type: 'text', text: '无思维' }],
          reasoningContent: null,
          createdAt: new Date('2020-01-02T00:00:00.000Z'),
        },
        {
          id: 'msg-old',
          role: 'assistant',
          content: '旧回复',
          parts: [{ type: 'text', text: '旧回复' }],
          reasoningContent: oldCot,
          createdAt: new Date('2020-01-01T00:00:00.000Z'),
        },
      ],
    });

    const messages = lastModelMessages();
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain(oldCot);
    expect(serialized).not.toContain(recentCot);
    expect(serialized).toContain('你好');
    const recent = messages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some(
          (part) =>
            typeof part === 'object' &&
            part !== null &&
            'text' in part &&
            (part as { text?: string }).text === '新回复',
        ),
    );
    expect(recent?.content).toEqual([
      { type: 'reasoning', text: '你好' },
      { type: 'text', text: '新回复' },
    ]);
    const middle = messages.find((m) => m.content === '无思维');
    expect(middle?.content).toBe('无思维');
  });

  it('does not spend a CoT history slot on assistants without reasoning', async () => {
    configMap.CHAT_WEB_REASONING_HISTORY_TURNS = '1';
    const keptCot = 'KEEP_OLDER_COT';

    await runHappyStream({
      messages: [
        {
          id: 'msg-user',
          role: 'user',
          content: 'hi',
          parts: [{ type: 'text', text: 'hi' }],
          createdAt: new Date('2020-01-03T00:00:00.000Z'),
        },
        {
          id: 'msg-plain',
          role: 'assistant',
          content: '无思维',
          parts: [{ type: 'text', text: '无思维' }],
          reasoningContent: null,
          createdAt: new Date('2020-01-02T00:00:00.000Z'),
        },
        {
          id: 'msg-cot',
          role: 'assistant',
          content: '更早但有思维',
          parts: [{ type: 'text', text: '更早但有思维' }],
          reasoningContent: keptCot,
          createdAt: new Date('2020-01-01T00:00:00.000Z'),
        },
      ],
    });

    const messages = lastModelMessages();
    expect(JSON.stringify(messages)).toContain(keptCot);
    expect(messages.find((m) => m.content === '无思维')?.content).toBe(
      '无思维',
    );
  });

  it.each([null, ''])(
    'does not invent a reasoning part when historical reasoningContent is %j',
    async (reasoningContent) => {
      await runHappyStream({
        messages: [
          {
            id: 'msg-user',
            role: 'user',
            content: 'hi',
            parts: [{ type: 'text', text: 'hi' }],
            createdAt: new Date('2020-01-02T00:00:00.000Z'),
          },
          {
            id: 'msg-asst',
            role: 'assistant',
            content: '可见回复',
            parts: [{ type: 'text', text: '可见回复' }],
            reasoningContent,
            createdAt: new Date('2020-01-01T00:00:00.000Z'),
          },
        ],
      });

      const assistant = lastModelMessages().find((m) => m.role === 'assistant');
      expect(assistant?.content).toBe('可见回复');
      expect(JSON.stringify(lastModelMessages())).not.toContain('"reasoning"');
    },
  );

  it('persists billable web cost when the stream ends without onEnd', async () => {
    billing.computeCostMicros.mockReturnValue(100n);
    billing.computeWebToolsCostMicros.mockReturnValue(5000n);
    webSession.billableSearchCount = 1;
    webSession.billableFetchCount = 2;
    webSession.sources = [
      { title: 't', url: 'https://a.com', snippet: 's', siteName: 'a' },
    ];

    await runHappyStream();

    expect(billing.recordSpend).toHaveBeenCalledTimes(1);
    expect(billing.incrementWeeklySpend).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      5100n,
    );
    expect(billing.computeWebToolsCostMicros).toHaveBeenCalledWith(1, 2);

    const aborted = txMessageCreate.mock.calls.filter(
      (call) => call[0]?.data?.role === MessageRole.assistant,
    );
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.[0].data).toEqual(
      expect.objectContaining({
        content: '',
        finishReason: 'aborted',
        costMicros: 5100n,
        webToolsCostMicros: 5000n,
        webSearchCount: 1,
        webFetchCount: 2,
        sources: [
          { title: 't', url: 'https://a.com', snippet: 's', siteName: 'a' },
        ],
        promptTokens: 0,
      }),
    );

    await capturedOnEnd?.({
      isAborted: false,
      responseMessage: {
        parts: [
          { type: 'reasoning', text: '思维' },
          { type: 'text', text: '累计全文' },
        ],
      },
    });

    expect(billing.recordSpend).toHaveBeenCalledTimes(1);
    expect(
      txMessageCreate.mock.calls.filter(
        (call) => call[0]?.data?.role === MessageRole.assistant,
      ),
    ).toHaveLength(1);
  });

  it('persists onEnd text rather than onFinish.text and adds web cost', async () => {
    const tokenCost = 1000n;
    const webCost = 15000n;
    billing.computeCostMicros.mockReturnValue(tokenCost);
    billing.computeWebToolsCostMicros.mockReturnValue(webCost);

    await runHappyStream();

    webSession.billableSearchCount = 2;
    webSession.billableFetchCount = 1;
    webSession.sources = [{ title: 't', url: 'https://a.com', snippet: 's' }];

    const streamTextArgs = streamTextMock.mock.calls[0]?.[0] as {
      onFinish?: (args: { usage: unknown; text?: string }) => void;
    };
    streamTextArgs.onFinish?.({
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        inputTokenDetails: { cacheReadTokens: 0, noCacheTokens: 10 },
        outputTokenDetails: { textTokens: 4, reasoningTokens: 0 },
      },
      text: 'ONLY_FINAL_STEP',
    });

    await capturedOnEnd?.({
      isAborted: false,
      responseMessage: { parts: [{ type: 'text', text: '累计全文' }] },
    });

    expect(billing.computeWebToolsCostMicros).toHaveBeenCalledWith(2, 1);
    expect(billing.incrementWeeklySpend).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      tokenCost + webCost,
    );
    expect(billing.recordSpend).toHaveBeenCalledWith(
      userId,
      tokenCost + webCost,
    );

    const assistant = txMessageCreate.mock.calls.find(
      (call) => call[0]?.data?.role === MessageRole.assistant,
    );
    expect(assistant?.[0].data.content).toBe('累计全文');
    expect(assistant?.[0].data.costMicros).toBe(tokenCost + webCost);
    expect(assistant?.[0].data.content).not.toContain('ONLY_FINAL_STEP');
    expect(assistant?.[0].data.reasoningContent ?? '').not.toContain(
      'ONLY_FINAL_STEP',
    );
  });

  it('does not hard-429 for in-turn tool cost after the stream has opened', async () => {
    billing.getWeeklySpendMicros.mockResolvedValue(0n);
    billing.getWeeklyBudgetMicros.mockReturnValue(1n);
    billing.computeWebToolsCostMicros.mockReturnValue(9_999_999n);

    await runHappyStream();

    expect(streamTextMock).toHaveBeenCalled();
    expect(billing.getWeeklySpendMicros).toHaveBeenCalledTimes(1);

    webSession.billableSearchCount = 1;
    await capturedOnEnd?.({
      isAborted: false,
      responseMessage: { parts: [{ type: 'text', text: 'ok' }] },
    });

    expect(billing.recordSpend).toHaveBeenCalledWith(userId, 9_999_999n);
  });

  it('still hard-429s before opening the stream when the weekly budget is spent', async () => {
    billing.getWeeklySpendMicros.mockResolvedValue(10n);
    billing.getWeeklyBudgetMicros.mockReturnValue(10n);

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
      expect((err as HttpException).message).toBe('本周对话额度已用完');
      return true;
    });

    expect(streamTextMock).not.toHaveBeenCalled();
    expect(createWebToolsMock).not.toHaveBeenCalled();
  });

  it('retries persist after a DB failure and does not mark persisted early', async () => {
    await runHappyStream();

    txMessageCreate.mockRejectedValueOnce(new Error('db down'));
    await expect(
      capturedOnEnd?.({
        isAborted: false,
        responseMessage: { parts: [{ type: 'text', text: '要入账' }] },
      }),
    ).rejects.toThrow('db down');
    expect(billing.recordSpend).not.toHaveBeenCalled();

    txMessageCreate.mockResolvedValue({});
    await capturedOnEnd?.({
      isAborted: false,
      responseMessage: { parts: [{ type: 'text', text: '要入账' }] },
    });

    expect(billing.recordSpend).toHaveBeenCalledTimes(1);
    expect(billing.incrementWeeklySpend).toHaveBeenCalledTimes(1);
    const assistant = txMessageCreate.mock.calls.filter(
      (call) => call[0]?.data?.role === MessageRole.assistant,
    );
    expect(assistant).toHaveLength(2);
    expect(assistant.at(-1)?.[0].data.content).toBe('要入账');
  });

  it('does not dereference session when execute throws before tools exist', async () => {
    createWebToolsMock.mockImplementation(() => {
      throw new Error('tools init failed');
    });

    await expect(runHappyStream()).rejects.toThrow('tools init failed');
    expect(billing.recordSpend).not.toHaveBeenCalled();
    expect(
      txMessageCreate.mock.calls.filter(
        (call) => call[0]?.data?.role === MessageRole.assistant,
      ),
    ).toHaveLength(0);
  });
});
