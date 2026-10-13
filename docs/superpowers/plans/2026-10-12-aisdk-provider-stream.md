# AI SDK Provider 流式接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除自研 SSE，改用 `@ai-sdk/deepseek` + 统一 `streamText` / `toUIMessageStream`，并以 `createUIMessageStream.onEnd` 作为唯一落盘入口。

**Architecture:** 薄工厂 `createLanguageModel` 按 `LLM_PROVIDER` 返回官方 language model；`ChatStreamService` 只做额度/并发/`data-chatMeta`/落盘；usage 由 `streamText.onFinish` 写入闭包，文本与思考从 `onEnd.responseMessage` 提取。

**Tech Stack:** NestJS、`ai` ^7、`@ai-sdk/deepseek` ^3、Vitest、Prisma、Redis

**Spec:** [`docs/superpowers/specs/2026-10-12-aisdk-provider-stream-design.md`](../specs/2026-10-12-aisdk-provider-stream-design.md)

---

## File map

| Path                                                                               | Action              | Responsibility                           |
| ---------------------------------------------------------------------------------- | ------------------- | ---------------------------------------- |
| `src/chat/llm/create-language-model.ts`                                            | Create              | Provider 工厂                            |
| `src/chat/llm/create-language-model.spec.ts`                                       | Create              | 工厂单测                                 |
| `src/chat/llm/extract-ui-message-text.ts`                                          | Create              | 从 UIMessage parts 抽 text/reasoning     |
| `src/chat/llm/extract-ui-message-text.spec.ts`                                     | Create              | 抽取单测                                 |
| `src/chat/llm/map-language-model-usage.ts`                                         | Create              | AI SDK usage → 计费/落库字段             |
| `src/chat/llm/map-language-model-usage.spec.ts`                                    | Create              | usage 映射单测                           |
| `src/chat/llm/deepseek-provider.replay.spec.ts`                                    | Create              | 真实 provider + 假 SSE 回放              |
| `src/chat/chat-stream.service.ts`                                                  | Rewrite stream path | AI SDK 流式 + onEnd 落盘                 |
| `src/chat/chat-stream.service.spec.ts`                                             | Rewrite             | data-chatMeta / onEnd abort / 历史无 CoT |
| `src/common/config/env.validation.ts`                                              | Modify              | `LLM_PROVIDERS` 仅 `deepseek`（本迭代）  |
| `src/common/config/env.validation.spec.ts`                                         | Modify              | 对齐 LLM_*                               |
| `.env.example` / `README.md` / `vitest.config.e2e.ts`                              | Modify              | 文档与 e2e env                           |
| `src/chat/utils/llm-*.ts` / `openai-compatible-sse*` / `model-messages-to-openai*` | Delete              | 自研 SSE 全家桶                          |

---

### Task 1: `createLanguageModel` 工厂（TDD）

**Files:**

- Create: `src/chat/llm/create-language-model.ts`
- Create: `src/chat/llm/create-language-model.spec.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/chat/llm/create-language-model.spec.ts
import { createLanguageModel } from './create-language-model.js';

describe('createLanguageModel', () => {
  it('returns a DeepSeek chat model for provider=deepseek', () => {
    const model = createLanguageModel({
      provider: 'deepseek',
      apiKey: 'test-key',
      baseURL: 'https://api.deepseek.com/v1',
      modelId: 'deepseek-flash',
    });
    expect(model).toBeTruthy();
    expect(typeof (model as { doStream?: unknown }).doStream).toBe('function');
  });

  it('throws Chinese error for unsupported provider', () => {
    expect(() =>
      createLanguageModel({
        provider: 'openai' as 'deepseek',
        apiKey: 'k',
        baseURL: 'https://example.com/v1',
        modelId: 'gpt',
      }),
    ).toThrow(/暂不支持的 LLM_PROVIDER/);
  });
});
```

（第二个用例若 TS 拦 `as`，改为传入运行时字符串：`provider: 'openai' as never`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- --run src/chat/llm/create-language-model.spec.ts`

Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
// src/chat/llm/create-language-model.ts
import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';

export type SupportedLlmProvider = 'deepseek';

export type CreateLanguageModelParams = {
  provider: string;
  apiKey: string;
  baseURL: string;
  modelId: string;
};

export function createLanguageModel(
  params: CreateLanguageModelParams,
): LanguageModel {
  const provider = params.provider.trim() || 'deepseek';
  if (provider === 'deepseek') {
    return createDeepSeek({
      apiKey: params.apiKey,
      baseURL: params.baseURL,
    }).chat(params.modelId);
  }
  throw new Error(`暂不支持的 LLM_PROVIDER: ${provider}`);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- --run src/chat/llm/create-language-model.spec.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/chat/llm/create-language-model.ts src/chat/llm/create-language-model.spec.ts
git commit -m "feat(chat): 新增 createLanguageModel 工厂"
```

---

### Task 2: UIMessage 文本抽取 + Usage 映射（TDD）

**Files:**

- Create: `src/chat/llm/extract-ui-message-text.ts`
- Create: `src/chat/llm/extract-ui-message-text.spec.ts`
- Create: `src/chat/llm/map-language-model-usage.ts`
- Create: `src/chat/llm/map-language-model-usage.spec.ts`

- [ ] **Step 1: 写失败测试**

```ts
// extract-ui-message-text.spec.ts
import { extractUiMessageText } from './extract-ui-message-text.js';

describe('extractUiMessageText', () => {
  it('joins text and reasoning parts', () => {
    expect(
      extractUiMessageText({
        id: 'a',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: '想一想' },
          { type: 'text', text: '你好' },
          { type: 'text', text: '世界' },
        ],
      }),
    ).toEqual({ text: '你好世界', reasoningText: '想一想' });
  });

  it('returns empty strings when parts missing', () => {
    expect(
      extractUiMessageText({ id: 'a', role: 'assistant', parts: [] }),
    ).toEqual({ text: '', reasoningText: null });
  });
});
```

```ts
// map-language-model-usage.spec.ts
import { mapLanguageModelUsage } from './map-language-model-usage.js';

describe('mapLanguageModelUsage', () => {
  it('maps cache + subtracts reasoning from completion when needed', () => {
    const mapped = mapLanguageModelUsage({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      inputTokenDetails: { cacheReadTokens: 4, noCacheTokens: 6 },
      outputTokenDetails: { reasoningTokens: 8, textTokens: 12 },
    } as never);
    expect(mapped).toMatchObject({
      promptTokens: 10,
      totalTokens: 30,
      promptCacheHitTokens: 4,
      promptCacheMissTokens: 6,
      completionTokens: 12,
      reasoningTokens: 8,
    });
  });

  it('returns zeros for null usage', () => {
    expect(mapLanguageModelUsage(null)).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- --run src/chat/llm/extract-ui-message-text.spec.ts src/chat/llm/map-language-model-usage.spec.ts`

Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// extract-ui-message-text.ts
export type UiMessageLike = {
  parts?: Array<{ type?: string; text?: string }>;
};

export function extractUiMessageText(
  message: UiMessageLike | null | undefined,
): {
  text: string;
  reasoningText: string | null;
} {
  const parts = message?.parts ?? [];
  let text = '';
  let reasoning = '';
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      text += part.text;
    } else if (part.type === 'reasoning' && typeof part.text === 'string') {
      reasoning += part.text;
    }
  }
  return { text, reasoningText: reasoning || null };
}
```

```ts
// map-language-model-usage.ts
import type { LanguageModelUsage } from 'ai';
import type { ChatUsageForBilling } from '../utils/chat-billing.util.js';

export type MappedLlmUsage = ChatUsageForBilling & {
  promptTokens: number;
  totalTokens: number;
};

export function mapLanguageModelUsage(
  usage: LanguageModelUsage | null | undefined,
): MappedLlmUsage {
  if (!usage) {
    return {
      promptTokens: 0,
      totalTokens: 0,
      promptCacheMissTokens: 0,
      promptCacheHitTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
    };
  }
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens ?? 0;
  const textTokens = usage.outputTokenDetails?.textTokens;
  const outputTokens = usage.outputTokens ?? 0;
  let completionTokens =
    typeof textTokens === 'number'
      ? textTokens
      : Math.max(0, outputTokens - (reasoningTokens || 0));
  if (
    typeof textTokens !== 'number' &&
    !(reasoningTokens > 0) &&
    outputTokens > 0
  ) {
    completionTokens = outputTokens;
  }
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const noCache = usage.inputTokenDetails?.noCacheTokens;
  const inputTokens = usage.inputTokens ?? 0;
  return {
    promptTokens: inputTokens,
    totalTokens: usage.totalTokens ?? 0,
    promptCacheHitTokens: cacheRead,
    promptCacheMissTokens:
      typeof noCache === 'number'
        ? noCache
        : Math.max(0, inputTokens - cacheRead),
    completionTokens,
    reasoningTokens,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- --run src/chat/llm/extract-ui-message-text.spec.ts src/chat/llm/map-language-model-usage.spec.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/chat/llm/extract-ui-message-text.ts src/chat/llm/extract-ui-message-text.spec.ts src/chat/llm/map-language-model-usage.ts src/chat/llm/map-language-model-usage.spec.ts
git commit -m "feat(chat): 抽取 UIMessage 文本与 usage 映射"
```

---

### Task 3: 真实 DeepSeek provider 假 SSE 回放（TDD）

**Files:**

- Create: `src/chat/llm/deepseek-provider.replay.spec.ts`

**目的：** 不 mock `@ai-sdk/deepseek` 内部解析；用假 `fetch` 守住 `reasoning-delta` + `max_tokens` + `thinking`。

- [ ] **Step 1: 写失败测试（此时若工厂已绿，本测应先因未接 streamText 路径而独立可写）**

```ts
// deepseek-provider.replay.spec.ts
import { streamText } from 'ai';
import { createLanguageModel } from './create-language-model.js';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]));
      i += 1;
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('DeepSeek provider SSE replay', () => {
  it('emits reasoning-delta and sends max_tokens + thinking', async () => {
    let requestBody = '';
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBody = String(init?.body ?? '');
      return sseResponse([
        'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"先分析"}}]}\n\n',
        'data: {"id":"1","choices":[{"index":0,"delta":{"content":"答案"}}]}\n\n',
        'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8,"prompt_cache_miss_tokens":3,"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
        'data: [DONE]\n\n',
      ]);
    };

    const deepseek = await import('@ai-sdk/deepseek');
    const model = deepseek
      .createDeepSeek({
        apiKey: 'x',
        baseURL: 'http://example.invalid/v1',
        fetch: fetchImpl,
      })
      .chat('deepseek-flash');

    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 4096,
      providerOptions: {
        deepseek: {
          thinking: { type: 'enabled' },
          reasoningEffort: 'high',
        },
      },
    });

    const events: Array<{ type: string; text?: string }> = [];
    for await (const part of result.fullStream) {
      if (part.type === 'reasoning-delta') {
        events.push({ type: part.type, text: part.text });
      }
      if (part.type === 'text-delta') {
        events.push({ type: part.type, text: part.text });
      }
    }

    const body = JSON.parse(requestBody) as Record<string, unknown>;
    expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning-delta', text: '先分析' }),
        expect.objectContaining({ type: 'text-delta', text: '答案' }),
      ]),
    );

    // also smoke createLanguageModel wiring
    expect(
      createLanguageModel({
        provider: 'deepseek',
        apiKey: 'x',
        baseURL: 'http://example.invalid/v1',
        modelId: 'deepseek-flash',
      }),
    ).toBeTruthy();
  });
});
```

> 注意：`fullStream` 事件字段名以本仓库 `ai@7` 实际为准；若是 `delta` 而非 `text`，把断言改成 `part.delta`。先跑测看类型/运行时再改断言，禁止猜错后硬过。

- [ ] **Step 2: 跑测试**

Run: `npm run test -- --run src/chat/llm/deepseek-provider.replay.spec.ts`

Expected: 若 DeepSeek 包正常解析则 PASS；若字段名不符则按失败信息微调断言（仍不得 mock provider）。

- [ ] **Step 3: Commit**

```bash
git add src/chat/llm/deepseek-provider.replay.spec.ts
git commit -m "test(chat): DeepSeek provider 假 SSE 回放覆盖 reasoning"
```

---

### Task 4: 重写 `ChatStreamService` 流式路径 + 服务单测（TDD）

**Files:**

- Modify: `src/chat/chat-stream.service.ts`
- Modify: `src/chat/chat-stream.service.spec.ts`

- [ ] **Step 1: 先改写/扩展失败测试（在实现前）**

在 `chat-stream.service.spec.ts` 中：

1. 去掉对 `./utils/llm-chat-stream.util.js` 的 mock。
2. mock `ai`：`streamText`、`toUIMessageStream`、`createUIMessageStream`、`pipeUIMessageStreamToResponse`。
3. mock `./llm/create-language-model.js`。
4. 捕获 `createUIMessageStream` 的 `execute` 与 `onEnd`。

必备用例：

```ts
it('writes data-chatMeta before merging UI stream', async () => {
  /* ... */
});

it('persists once on onEnd abort with finishReason=aborted', async () => {
  // 调用 stream() 后取出 onEnd
  // await onEnd({ isAborted: true, responseMessage: { parts: [{type:'text', text:'半截'}] } })
  // expect billing.recordSpend / incrementWeeklySpend / message create 各一次
  // 再调一次 onEnd → 仍只一次（幂等）
});

it('buildModelMessages does not put historical reasoning into model messages', async () => {
  // prisma.message.findMany 返回 assistant 带 reasoningContent
  // 通过 mock streamText 捕获 messages 参数
  // expect assistant content 为可见文本；JSON.stringify(messages) 不含旧 CoT 字符串
});
```

- [ ] **Step 2: 跑服务单测确认关键新断言失败**

Run: `npm run test -- --run src/chat/chat-stream.service.spec.ts`

Expected: FAIL（仍绑定旧 `runLlmChatStream`）

- [ ] **Step 3: 重写 `stream()` 核心（保留额度/并发/buildModelMessages 骨架）**

实现要点（写入 `chat-stream.service.ts`）：

```ts
import {
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  streamText,
  toUIMessageStream,
  type LanguageModelUsage,
  type ModelMessage,
} from 'ai';
import { createLanguageModel } from './llm/create-language-model.js';
import { extractUiMessageText } from './llm/extract-ui-message-text.js';
import { mapLanguageModelUsage } from './llm/map-language-model-usage.js';

// 在 stream() 内，替换 runLlmChatStream 整段：
const apiKey = this.configService.getOrThrow<string>('LLM_API_KEY');
const baseURL = this.configService.getOrThrow<string>('LLM_BASE_URL');
const modelId = this.configService.getOrThrow<string>('LLM_MODEL');
const provider =
  this.configService.get<string>('LLM_PROVIDER')?.trim() || 'deepseek';
const maxOutputTokens = Number(
  this.configService.get('CHAT_MAX_TOKENS', '4096'),
);

const model = createLanguageModel({ provider, apiKey, baseURL, modelId });

let lastUsage: LanguageModelUsage | undefined;
let persisted = false;

const persistOnce = async (args: {
  text: string;
  reasoningText: string | null;
  finishReason: string | null;
}) => {
  if (persisted) return;
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

const stream = createUIMessageStream({
  execute: ({ writer }) => {
    writer.write({
      type: 'data-chatMeta',
      data: { userMessageId, assistantMessageId, quota: null },
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
            userId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 512) || 'anonymous',
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
    const { text, reasoningText } = extractUiMessageText(responseMessage);
    await persistOnce({
      text,
      reasoningText,
      finishReason: isAborted ? 'aborted' : 'stop',
    });
  },
  onError: (error) => (error instanceof Error ? error.message : String(error)),
  generateId: () => assistantMessageId,
});

await pipeUIMessageStreamToResponse({
  response: res,
  stream,
  headers: { 'X-Accel-Buffering': 'no' },
});
```

同步修改：

1. `persistAssistantMessage` 的 `usage` 参数改为接受 `MappedLlmUsage`（或内联用 `mapLanguageModelUsage` 的返回值），删除对 `LlmStreamUsage` / `runLlmChatStream` 的 import。
2. `buildModelMessages` 里图片 `providerOptions` 改为：

```ts
providerOptions: {
  deepseek: { imageDetail: detail }, // detail: low|high|original|auto
},
```

3. Assistant 历史继续 `messages.push({ role: 'assistant', content: msg.content })`，**不要**附加 `reasoningContent`。

- [ ] **Step 4: 跑服务单测至全绿**

Run: `npm run test -- --run src/chat/chat-stream.service.spec.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/chat/chat-stream.service.ts src/chat/chat-stream.service.spec.ts
git commit -m "refactor(chat): 流式改用 @ai-sdk/deepseek 与 onEnd 落盘"
```

---

### Task 5: 删除自研 SSE 全家桶

**Files:** Delete all of:

- `src/chat/utils/llm-chat-stream.util.ts`
- `src/chat/utils/llm-chat-stream.util.spec.ts`
- `src/chat/utils/openai-compatible-sse.util.ts`
- `src/chat/utils/openai-compatible-sse.util.spec.ts`
- `src/chat/utils/llm-provider-profiles.ts`
- `src/chat/utils/llm-provider-profiles.spec.ts`
- `src/chat/utils/model-messages-to-openai.util.ts`

- [ ] **Step 1: 删除文件**

```bash
git rm src/chat/utils/llm-chat-stream.util.ts src/chat/utils/llm-chat-stream.util.spec.ts src/chat/utils/openai-compatible-sse.util.ts src/chat/utils/openai-compatible-sse.util.spec.ts src/chat/utils/llm-provider-profiles.ts src/chat/utils/llm-provider-profiles.spec.ts src/chat/utils/model-messages-to-openai.util.ts
```

（若尚未 tracked，用 `Remove-Item` / `rm` 后保证工作树干净。）

- [ ] **Step 2: 全量单测 + typecheck**

Run:

```bash
npm run test -- --run
npm run typecheck
npm run lint
```

Expected: 全绿；无残留 `runLlmChatStream` / `DeepSeekStream` / `llm-provider-profiles` 引用。

- [ ] **Step 3: Commit**

```bash
git add -A src/chat/utils
git commit -m "refactor(chat): 移除自研 SSE 与多厂商 profiles"
```

---

### Task 6: Env / README / e2e 同批收齐

**Files:**

- Modify: `src/common/config/env.validation.ts`
- Modify: `src/common/config/env.validation.spec.ts`
- Modify: `.env.example`
- Modify: `vitest.config.e2e.ts`
- Modify: `README.md`

- [ ] **Step 1: 收窄校验枚举并确认测试**

`env.validation.ts`：

```ts
const LLM_PROVIDERS = ['deepseek'] as const;
```

删除对已删 `llm-provider-profiles` 的注释同步说明；`optionalEnum(env, 'LLM_PROVIDER', LLM_PROVIDERS)` 保留。

`env.validation.spec.ts`：未知 provider（如 `qwen`）应 throw；`deepseek` 通过。

- [ ] **Step 2: `.env.example` / e2e / README**

`.env.example` 示例块：

```bash
# LLM（OpenAI 兼容网关 + 官方 @ai-sdk 包；本迭代仅 deepseek）
LLM_PROVIDER=deepseek
LLM_API_KEY=
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-flash
```

`vitest.config.e2e.ts`：

```ts
LLM_API_KEY: 'test-llm-key-not-placeholder',
LLM_BASE_URL: 'https://llm.example.com/v1',
LLM_MODEL: 'test-model',
LLM_PROVIDER: 'deepseek',
CHAT_ATTACHMENT_STORAGE: 'disabled',
```

README：流式说明改为「`@ai-sdk/deepseek` + `streamText`；落盘在 `createUIMessageStream.onEnd`」；删除自研 SSE 描述；注明本地若仍有 `DEEPSEEK_*` 需手动改为 `LLM_*`（无运行时别名）。

- [ ] **Step 3: 跑相关测试**

Run:

```bash
npm run test -- --run src/common/config/env.validation.spec.ts src/chat
npm run typecheck
npm run lint
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/common/config/env.validation.ts src/common/config/env.validation.spec.ts .env.example vitest.config.e2e.ts README.md
git commit -m "docs(chat): 收齐 LLM_* 环境变量与流式文档"
```

---

### Task 7: 最终验收

- [ ] **Step 1: 全量验证**

```bash
npm run lint && npm run typecheck && npm run test -- --run
```

Expected: 全绿。

- [ ] **Step 2: 对照 spec 成功标准勾选**

- [ ] `createLanguageModel`：deepseek 可用；未知 provider 抛中文错
- [ ] 真实 provider 假 SSE：`reasoning-delta` + 请求含 `max_tokens` / `thinking`
- [ ] `onEnd(isAborted)` 落库一次且 `finishReason='aborted'`
- [ ] `data-chatMeta` 存在
- [ ] 历史 assistant 不回传 reasoning
- [ ] 自研 SSE 文件已删
- [ ] lint / typecheck / unit tests 全绿

- [ ] **Step 3: 若有未提交验收修复，单独 commit**

```bash
git status
# 仅在有修复时：
git commit -m "test(chat): 补齐 AI SDK 流式验收断言"
```

---

## Spec coverage self-check

| Spec 要求                                               | Task       |
| ------------------------------------------------------- | ---------- |
| 工厂 deepseek / 未知抛错                                | Task 1     |
| onEnd 唯一落盘 + usage 闭包                             | Task 4     |
| abort 幂等 `finishReason=aborted`                       | Task 4     |
| 真实 SSE 回放 reasoning + max_tokens                    | Task 3     |
| data-chatMeta                                           | Task 4     |
| 历史不回传 CoT                                          | Task 4     |
| deepseek.userId / imageDetail / reasoningEffort 禁 none | Task 4     |
| 删除自研 SSE 全家桶                                     | Task 5     |
| LLM_* 同批迁移无别名                                    | Task 6     |
| 默认 provider=deepseek                                  | Task 4 + 6 |

## Placeholder scan

无 TBD /「稍后实现」步骤；关键代码块已给出。

## Type consistency

- `createLanguageModel` / `extractUiMessageText` / `mapLanguageModelUsage` / `persistOnce` / `MappedLlmUsage` 命名在各 Task 一致。
- Env：`LLM_PROVIDER|API_KEY|BASE_URL|MODEL` 全篇统一。
