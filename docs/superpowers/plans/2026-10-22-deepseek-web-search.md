# DeepSeek Search/Fetch 联网 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 `streamText` 流式对话上挂载官方 Search/Fetch 工具（Function Calling），支持过程/来源 data parts、来源落库、按次计入周预算，并正确处理多步循环与历史 reasoning。

**Architecture:** `DeepSeekToolsClient` 用 `LLM_BASE_URL` 的 origin 调 `/v1/tools/search|fetch`；`createWebTools` 提供 AI SDK `tool()`（白名单、原子计数、写队列）；`ChatStreamService` 设 `stopWhen: isStepCount(N)`、回传历史 CoT、落库取 `onEnd.responseMessage` + `onFinish.usage`；abort 也记 web 费用。

**Tech Stack:** NestJS 12、AI SDK v7（`ai` / `@ai-sdk/deepseek`）、Prisma 6、Vitest、class-validator

**Spec:** [`docs/superpowers/specs/2026-10-22-deepseek-web-search-design.md`](../specs/2026-10-22-deepseek-web-search-design.md)

---

## File map

| Path                                                                 | Action | Responsibility                                  |
| -------------------------------------------------------------------- | ------ | ----------------------------------------------- |
| `.env.example`                                                       | Modify | 联网单价 / 上限 / CoT 限额注释与默认值          |
| `src/common/config/env.validation.ts`                                | Modify | 新 env；`LLM_BASE_URL` 须为合法 http(s) URL     |
| `src/common/config/env.validation.spec.ts`                           | Modify | URL 非法失败；新 optional int                   |
| `prisma/schema.prisma`                                               | Modify | Message：`sources` / web 计数与费用列           |
| `prisma/migrations/20261022120000_add_web_tool_fields/migration.sql` | Create | 新增列默认值                                    |
| `src/chat/llm/deepseek-tools.types.ts`                               | Create | 官方 Request/Response TS 类型（snake_case）     |
| `src/chat/llm/deepseek-tools.client.ts`                              | Create | origin 派生 + search/fetch HTTP                 |
| `src/chat/llm/deepseek-tools.client.spec.ts`                         | Create | mock fetch；双 `/v1` 回归                       |
| `src/chat/utils/chat-billing.util.ts`                                | Modify | `computeWebToolsCostMicros`                     |
| `src/chat/utils/chat-billing.util.spec.ts`                           | Modify | 单价 × 次数                                     |
| `src/chat/chat-billing.service.ts`                                   | Modify | 读联网单价；封装 compute                        |
| `src/chat/llm/extract-urls-from-text.ts`                             | Create | 用户消息 URL 解析（白名单种子）                 |
| `src/chat/llm/extract-urls-from-text.spec.ts`                        | Create |                                                 |
| `src/chat/llm/create-web-tools.ts`                                   | Create | `web_search` / `web_fetch` tools + 会话态       |
| `src/chat/llm/create-web-tools.spec.ts`                              | Create | 上限、白名单、计费计数                          |
| `src/chat/chat-stream.service.ts`                                    | Modify | tools、stopWhen、reasoning 历史、persist、abort |
| `src/chat/chat-stream.service.spec.ts`                               | Modify | 多步正文、无 CoT、abort 记账等                  |
| `src/chat/chat-messages.service.ts`                                  | Modify | DTO 含 `sources`                                |
| `src/chat/chat.module.ts`                                            | Modify | 若需提供 Client                                 |
| `test/chat.e2e-spec.ts`                                              | Modify | mock 工具客户端；有文本                         |
| `docs/chat-api-frontend.md`                                          | Modify | data parts + `sources` 字段                     |

---

### Task 1: Env 校验与 `.env.example`

**Files:**

- Modify: `.env.example`
- Modify: `src/common/config/env.validation.ts`
- Modify: `src/common/config/env.validation.spec.ts`

- [ ] **Step 1: 写失败用例 — 非法 `LLM_BASE_URL`**

在 `env.validation.spec.ts` 增加：

```ts
it('rejects non-URL LLM_BASE_URL', () => {
  expect(() =>
    validateEnv({
      ...validBaseEnv, // 已有合法必填字段 fixture
      LLM_BASE_URL: 'not-a-url',
    }),
  ).toThrow(/LLM_BASE_URL/);
});
```

- [ ] **Step 2: 跑测确认失败（尚未实现）**

Run: `npx vitest run src/common/config/env.validation.spec.ts`

- [ ] **Step 3: 实现 URL 校验 + 新 optional ints**

在 `validateEnv` 中，`requireString(env, 'LLM_BASE_URL', 8)` 之后：

```ts
function requireHttpUrl(env: Record<string, unknown>, key: string): void {
  const value = requireString(env, key, 8);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`环境变量 ${key} 必须是合法 URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`环境变量 ${key} 必须是 http(s) URL`);
  }
}
```

将 `LLM_BASE_URL` 改为走 `requireHttpUrl`。并 `optionalPositiveInt` / `optionalNonNegativeInt` 注册：

- `CHAT_PRICE_WEB_SEARCH_MICROS` / `CHAT_PRICE_WEB_FETCH_MICROS`
- `CHAT_WEB_FETCH_MAX_CHARS` / `CHAT_WEB_SEARCH_DEFAULT_COUNT` / `CHAT_WEB_SEARCH_COUNT_CAP`
- `CHAT_WEB_SEARCH_MAX_PER_TURN` / `CHAT_WEB_FETCH_MAX_PER_TURN` / `CHAT_WEB_TOOL_MAX_STEPS`
- `CHAT_WEB_REASONING_HISTORY_TURNS` / `CHAT_WEB_REASONING_MAX_CHARS`

- [ ] **Step 4: 更新 `.env.example`**

在 LLM 段后追加默认值与中文注释（与 Spec 表一致；`CHAT_WEB_SEARCH_DEFAULT_COUNT=10` 与 `COUNT_CAP=10` 注明 CAP 默认不额外收紧）。

- [ ] **Step 5: 跑测通过并提交**

```bash
npx vitest run src/common/config/env.validation.spec.ts
git add .env.example src/common/config/env.validation.ts src/common/config/env.validation.spec.ts
git commit -m "feat(config): 校验 LLM_BASE_URL 并登记联网相关环境变量"
```

---

### Task 2: Prisma Message 联网字段

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261022120000_add_web_tool_fields/migration.sql`

- [ ] **Step 1: 更新 schema**

在 `Message` 模型 `costMicros` 附近增加：

```prisma
  sources            Json?     @map("sources")
  webSearchCount     Int       @default(0) @map("web_search_count")
  webFetchCount      Int       @default(0) @map("web_fetch_count")
  webToolsCostMicros BigInt    @default(0) @map("web_tools_cost_micros")
```

- [ ] **Step 2: 写 migration SQL**

```sql
ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "sources" JSONB,
  ADD COLUMN IF NOT EXISTS "web_search_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "web_fetch_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "web_tools_cost_micros" BIGINT NOT NULL DEFAULT 0;
```

- [ ] **Step 3: generate + deploy 本地**

```bash
npx prisma generate
npx prisma migrate deploy
```

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261022120000_add_web_tool_fields/
git commit -m "feat(chat): Message 增加 sources 与联网计费字段"
```

---

### Task 3: DeepSeekToolsClient

**Files:**

- Create: `src/chat/llm/deepseek-tools.types.ts`
- Create: `src/chat/llm/deepseek-tools.client.ts`
- Create: `src/chat/llm/deepseek-tools.client.spec.ts`

- [ ] **Step 1: 写类型文件**（与 Spec 官方 Schema 一致，snake_case）

```ts
export type DeepSeekSearchRequest = {
  query: string;
  count?: number;
  ori_question?: string | null;
  localization?: string;
  need_content?: boolean;
};

export type DeepSeekSearchResult = {
  rerank_score: number;
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  site_name: string | null;
  site_icon: string | null;
  date: string | null;
  authority: number;
};

export type DeepSeekSearchResponse = { results: DeepSeekSearchResult[] };

export type DeepSeekFetchRequest = { url: string };
export type DeepSeekFetchResponse = { title: string; content: string };
```

- [ ] **Step 2: 写失败测 — base 带 `/v1` 时 URL 不得双拼**

```ts
it('builds tools URL from origin when LLM_BASE_URL ends with /v1', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
  vi.stubGlobal('fetch', fetchMock);
  const client = new DeepSeekToolsClient({
    apiKey: 'sk-test',
    baseURL: 'https://api.deepseek.com/v1',
  });
  await client.search({ query: 'hello', count: 1 });
  expect(fetchMock.mock.calls[0][0]).toBe(
    'https://api.deepseek.com/v1/tools/search',
  );
});
```

- [ ] **Step 3: 实现 Client**

```ts
export function toolsApiOrigin(llmBaseUrl: string): string {
  return new URL(llmBaseUrl).origin;
}

export class DeepSeekToolsClient {
  constructor(
    private readonly opts: {
      apiKey: string;
      baseURL: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private url(path: '/v1/tools/search' | '/v1/tools/fetch'): string {
    return `${toolsApiOrigin(this.opts.baseURL)}${path}`;
  }

  async search(
    body: DeepSeekSearchRequest,
    signal?: AbortSignal,
  ): Promise<DeepSeekSearchResponse> {
    /* POST JSON, map 4xx, 1 retry on 429/5xx */
  }

  async fetchPage(
    body: DeepSeekFetchRequest,
    signal?: AbortSignal,
  ): Promise<DeepSeekFetchResponse> {
    /* same */
  }
}
```

计费判定留给上层：Client 只返回结果；`results.length===0` / 空 `content` 由 tools 层决定不计费。

- [ ] **Step 4: 补空结果 / 4xx 测；跑通；提交**

```bash
npx vitest run src/chat/llm/deepseek-tools.client.spec.ts
git add src/chat/llm/deepseek-tools.*
git commit -m "feat(chat): 封装 DeepSeek Search/Fetch HTTP 客户端"
```

---

### Task 4: 联网计费纯函数 + BillingService

**Files:**

- Modify: `src/chat/utils/chat-billing.util.ts`
- Modify: `src/chat/utils/chat-billing.util.spec.ts`（若无则创建）
- Modify: `src/chat/chat-billing.service.ts`

- [ ] **Step 1: 测**

```ts
expect(computeWebToolsCostMicros(2, 1, { search: 5000n, fetch: 5000n })).toBe(
  15000n,
);
expect(computeWebToolsCostMicros(0, 0, { search: 5000n, fetch: 5000n })).toBe(
  0n,
);
```

- [ ] **Step 2: 实现**

```ts
export function computeWebToolsCostMicros(
  searchCount: number,
  fetchCount: number,
  prices: { search: bigint; fetch: bigint },
): bigint {
  return (
    BigInt(Math.max(0, searchCount)) * prices.search +
    BigInt(Math.max(0, fetchCount)) * prices.fetch
  );
}
```

`ChatBillingService` 增加 `getWebToolPrices()` 从 Config 读默认 `5000`，以及 `computeWebToolsCostMicros(s, f)`。

- [ ] **Step 3: 提交**

```bash
git commit -m "feat(chat): 联网 Search/Fetch 按次费用计算"
```

---

### Task 5: URL 提取 + createWebTools

**Files:**

- Create: `src/chat/llm/extract-urls-from-text.ts` + `.spec.ts`
- Create: `src/chat/llm/create-web-tools.ts` + `.spec.ts`

- [ ] **Step 1: URL 提取测与实现**

匹配 `https?://` 开头、去掉尾部中文标点；返回去重数组。

- [ ] **Step 2: createWebTools 测（优先）**

覆盖：

1. search 超 `CHAT_WEB_SEARCH_MAX_PER_TURN` 不调 client
2. fetch URL 不在白名单 → 不调 client
3. 用户消息 URL 在白名单可 fetch
4. 成功 search 后 `billableSearchCount++` 且 `results.length>0`
5. data 写队列：顺序调用 `writer.write`

- [ ] **Step 3: 实现 `createWebTools(ctx)`**

共享类型（可放在 `create-web-tools.ts` 或 `deepseek-tools.types.ts`）：

```ts
export type WebSource = {
  title: string;
  url: string;
  snippet: string;
  siteName?: string | null;
  fetched?: boolean;
};
```

会话态：

```ts
type WebToolsSession = {
  allowedFetchUrls: Set<string>;
  searchCount: number;
  fetchCount: number;
  billableSearchCount: number;
  billableFetchCount: number;
  sources: WebSource[];
  writeQueue: Promise<void>;
};
```

过程 data parts（经同一 `writeQueue`）：

```ts
// search 开始 / 结束 / 失败
writer.write({ type: 'data-webSearch', data: { status, query, errorText? } });
// fetch 开始 / 结束 / 失败
writer.write({ type: 'data-webFetch', data: { status, url, title?, errorText? } });
```

- `web_search` / `web_fetch`：`tool({ description, inputSchema: jsonSchema(...), execute })`
- 预占计数（同步 `++` 后再 await HTTP）
- `ori_question`：码点截断用户原问
- fetch 成功：截断 content + `<untrusted_web_content>`
- 每次成功 search/fetch 更新 sources，经 `enqueueWrite(() => writer.write({ type: 'data-webSources', data: { sources } }))`

返回 `{ tools, session }` 供 stream 结束读计数。

- [ ] **Step 4: 跑测提交**

```bash
npx vitest run src/chat/llm/extract-urls-from-text.spec.ts src/chat/llm/create-web-tools.spec.ts
git commit -m "feat(chat): 实现 web_search/web_fetch 工具与白名单"
```

---

### Task 6: ChatStreamService 集成

**Files:**

- Modify: `src/chat/chat-stream.service.ts`
- Modify: `src/chat/chat-stream.service.spec.ts`
- Modify: `src/chat/chat.module.ts`（如需 provider）

- [ ] **Step 1: 改 `buildModelMessages`**

对 assistant：若 `reasoningContent` 非空且在历史限额内，push：

```ts
messages.push({
  role: 'assistant',
  content: [
    { type: 'reasoning', text: truncatedReasoning },
    { type: 'text', text: msg.content },
  ],
});
```

限额：最近 `CHAT_WEB_REASONING_HISTORY_TURNS`（默认 4）条含 CoT；单条 `CHAT_WEB_REASONING_MAX_CHARS`（默认 4000）码点截断。

- [ ] **Step 2: `stream` 内注册 tools**

```ts
import { isStepCount, jsonSchema, tool, streamText, ... } from 'ai';

const maxSteps = Number(config.get('CHAT_WEB_TOOL_MAX_STEPS', '8'));
const userText = this.extractLastUserText(dto.messages);
const { tools, session } = createWebTools({
  client,
  writer, // 在 createUIMessageStream execute 内创建
  userText,
  oriQuestion: userText,
  config: { /* limits from ConfigService */ },
  signal: abortController.signal,
});

const result = streamText({
  model,
  messages: modelMessages,
  tools,
  stopWhen: isStepCount(maxSteps),
  abortSignal: abortController.signal,
  // ...existing providerOptions
  onFinish: ({ usage }) => { lastUsage = usage; },
});

writer.merge(toUIMessageStream({
  stream: result.stream,
  tools,
  sendReasoning: thinking,
  generateMessageId: () => assistantMessageId,
  onError: ...,
}));
```

注意：`writer` 仅在 `execute` 内可用 → `createWebTools` 须在 `execute` 回调里创建；`session` 用外层 `let` 引用以便 `onEnd`/`finally` 读计数。

- [ ] **Step 3: persist 硬约束**

`onEnd`：`extractUiMessageText(responseMessage)` → 正文/CoT；`mapLanguageModelUsage(lastUsage)` → token；`webToolsCost = billing.computeWebToolsCostMicros(session.billableSearchCount, session.billableFetchCount)`；写入 `sources`、counts、`webToolsCostMicros`、`costMicros = token + web`。

abort/`finally`：若尚未 `persisted` 且有 billable web 或已有文本，同样 persist（usage 可全 0）。

- [ ] **Step 4: 单测**

1. mock `streamText`/`createWebTools`：断言传入 `stopWhen` / `tools`
2. 历史**有** CoT：发出的 model messages 中该 assistant 含 `{ type: 'reasoning', text }`
3. 历史**无** CoT（`reasoningContent=null`）+ 始终挂 tools：对最终发给 provider 的 payload 断言存在 `reasoning_content` 且值为 `""`（可 spy provider / 封装层）；不捏造正文
4. abort：`recordSpend` / `incrementWeeklySpend` 仍带 web cost
5. 落库文本来自 `onEnd` 累计 message（mock `extractUiMessageText`），**禁止**用 `onFinish.text`
6. 本轮工具过程**不**因累计费用触发硬 429（开流前硬拦保留；中途软限制：继续跑完并入账）

- [ ] **Step 5: 提交**

```bash
git commit -m "feat(chat): 流式对话接入 Search/Fetch 工具与来源落库"
```

---

### Task 7: Messages API 返回 `sources`

**Files:**

- Modify: `src/chat/chat-messages.service.ts`
- Modify: 对应 `.spec.ts`（若有）

- [ ] **Step 1:** `MessageDto` 增加 `sources: WebSource[] | null`
- [ ] **Step 2:** list 映射 `row.sources ?? null`（勿把金额/count 暴露出去）
- [ ] **Step 3:** 提交 `feat(chat): 消息历史返回 sources`

---

### Task 8: e2e + 前端文档

**Files:**

- Modify: `test/chat.e2e-spec.ts`
- Modify: `docs/chat-api-frontend.md`

- [ ] **Step 1:** e2e mock `DeepSeekToolsClient` 或整个 tools（模块 override），断言流式 200 且响应含 text delta / 非空结束
- [ ] **Step 2:** 文档增加 `data-webSearch` / `data-webFetch` / `data-webSources` 与历史 `sources` 字段说明
- [ ] **Step 3:** 提交 `docs(chat): 同步联网流式与 sources 契约` + `test(chat): e2e 覆盖联网工具流式路径`

---

### Task 9: 真网门禁（人工）

- [ ] 用真实 `LLM_API_KEY`：存量会话（无 CoT）发一条需联网的问题，确认 **不 400** 且能出正文
- [ ] 用户消息粘贴 URL，确认可 `web_fetch`
- [ ] abort 中途后查 DB：`web_tools_cost_micros` > 0（若已发生成功 search）
- [ ] 不通过则按 Spec 降级方案开 issue，勿合入 develop

---

## Spec coverage checklist

| Spec 要求                    | Task |
| ---------------------------- | ---- |
| origin 工具 URL / 无双 `/v1` | 3    |
| `isStepCount` / 默认非 1     | 6    |
| 历史 CoT 回传 + 限额         | 6    |
| 无 CoT 契约 + 真网           | 6, 9 |
| sources 幂等 data part       | 5    |
| abort 记 web 费              | 6    |
| fetch 8k + 白名单含用户 URL  | 5    |
| env 三件套 + URL 校验        | 1    |
| 落库 onEnd / usage onFinish  | 6    |
| Message 列 + 历史 DTO        | 2, 7 |
| 计费合并周预算               | 4, 6 |
| 前端文档                     | 8    |

## Placeholder scan

无 TBD/TODO；关键代码路径已给出签名与断言要点。
