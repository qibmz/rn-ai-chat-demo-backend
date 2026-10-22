# DeepSeek Search/Fetch 联网 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 `streamText` 流式对话上挂载官方 Search/Fetch 工具（Function Calling），支持过程/来源 data parts、来源落库、按次计入周预算，并正确处理多步循环与历史 reasoning。

**Architecture:** `DeepSeekToolsClient`（Nest provider）用 `LLM_BASE_URL` origin 调 `/v1/tools/search|fetch`；`ChatModelFactory`（Nest provider）封装 `createLanguageModel`，供 e2e/单测替换；`createWebTools` 提供 AI SDK `tool()`（白名单、原子计数、写队列）；`ChatStreamService` 设 `stopWhen: isStepCount(N)`、回传历史 CoT、落库取 `onEnd.responseMessage` + `onFinish.usage`；abort 也记 web 费用。

**Tech Stack:** NestJS 12、AI SDK v7（`ai` / `@ai-sdk/deepseek`）、Prisma 6、Vitest、class-validator

**Spec:** [`docs/superpowers/specs/2026-10-22-deepseek-web-search-design.md`](../specs/2026-10-22-deepseek-web-search-design.md)

---

## File map

| Path                                                                 | Action | Responsibility                                                      |
| -------------------------------------------------------------------- | ------ | ------------------------------------------------------------------- |
| `.env.example`                                                       | Modify | 联网单价 / 上限 / CoT 限额 / 每步 max tokens 注释与默认值           |
| `src/common/config/env.validation.ts`                                | Modify | 新 env；`LLM_BASE_URL` 须为合法 http(s) URL                         |
| `src/common/config/env.validation.spec.ts`                           | Modify | URL 非法失败；新 optional int                                       |
| `prisma/schema.prisma`                                               | Modify | Message：`sources` / web 计数与费用列                               |
| `prisma/migrations/20261022120000_add_web_tool_fields/migration.sql` | Create | 新增列默认值                                                        |
| `src/chat/llm/deepseek-tools.types.ts`                               | Create | 官方 Request/Response TS 类型（snake_case）                         |
| `src/chat/llm/deepseek-tools.client.ts`                              | Create | origin 派生 + search/fetch HTTP；纯类 + Nest `useFactory` 注册      |
| `src/chat/llm/deepseek-tools.client.spec.ts`                         | Create | mock fetch；双 `/v1`；abortSignal / 超时透传                        |
| `src/chat/llm/chat-model.factory.ts`                                 | Create | `@Injectable()` 薄封装 `createLanguageModel`（e2e/单测可 override） |
| `src/chat/utils/chat-billing.util.ts`                                | Modify | `computeWebToolsCostMicros`                                         |
| `src/chat/utils/chat-billing.util.spec.ts`                           | Modify | 单价 × 次数                                                         |
| `src/chat/chat-billing.service.ts`                                   | Modify | 读联网单价；封装 compute                                            |
| `src/chat/llm/extract-urls-from-text.ts`                             | Create | 用户消息 URL 解析（白名单种子）                                     |
| `src/chat/llm/extract-urls-from-text.spec.ts`                        | Create |                                                                     |
| `src/chat/llm/create-web-tools.ts`                                   | Create | `web_search` / `web_fetch` tools + 会话态                           |
| `src/chat/llm/create-web-tools.spec.ts`                              | Create | 上限、白名单、计费、截断包裹、data 顺序、中文错误                   |
| `src/chat/chat-stream.service.ts`                                    | Modify | 注入 Client/Factory；tools、stopWhen、reasoning、persist、abort     |
| `src/chat/chat-stream.service.spec.ts`                               | Modify | 更新 `ai`/billing mock；替换旧 CoT 断言；abort/正常 spend           |
| `src/chat/llm/deepseek-provider.replay.spec.ts`                      | Modify | 无 CoT assistant → 请求体 `reasoning_content === ""`                |
| `src/chat/chat-messages.service.ts`                                  | Modify | DTO 含 `sources`                                                    |
| `src/chat/chat-messages.service.spec.ts`                             | Create | `sources` 返回；金额/count 不外泄                                   |
| `src/chat/chat.module.ts`                                            | Modify | 注册 `DeepSeekToolsClient` + `ChatModelFactory` providers           |
| `test/chat.e2e-spec.ts`                                              | Modify | override Factory（假模型）+ Client；断言 200 + text                 |
| `docs/chat-api-frontend.md`                                          | Modify | data parts + `sources` 字段                                         |

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
- `CHAT_WEB_STEP_MAX_TOKENS`（默认 `2048`：多步时**每步** `maxOutputTokens`，避免 8×4096 放大；见 Task 6）

- [ ] **Step 4: 更新 `.env.example`**

在 LLM 段后追加默认值与中文注释（与 Spec 表一致；`CHAT_WEB_SEARCH_DEFAULT_COUNT=10` 与 `COUNT_CAP=10` 注明 CAP 默认不额外收紧；注明联网轮输出成本可能因多步高于普通轮，故每步默认 2048）。

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

- [ ] **Step 3: validate + generate + deploy 本地**

```bash
npx prisma validate
npx prisma generate
npx prisma migrate deploy
```

（手写 `ADD COLUMN IF NOT EXISTS` 与 Prisma checksum 无冲突；本地/CI 部署一次即可。）

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261022120000_add_web_tool_fields/
git commit -m "feat(chat): Message 增加 sources 与联网计费字段"
```

---

### Task 3: DeepSeekToolsClient + Nest 注册

**Files:**

- Create: `src/chat/llm/deepseek-tools.types.ts`
- Create: `src/chat/llm/deepseek-tools.client.ts`
- Create: `src/chat/llm/deepseek-tools.client.spec.ts`
- Modify: `src/chat/chat.module.ts`（本 Task 先注册 Client；`ChatModelFactory` 在 Task 6）

**DI 定案（P1-6）：** Client 是**纯类**（单测可 `new`），模块用 `useFactory` 注册为 Nest provider，**禁止**在 `ChatStreamService` 里直接 `new`（否则 e2e 换不掉）。

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

- [ ] **Step 2: 写失败测 — base 带 `/v1` 时 URL 不得双拼；abortSignal 透传**

```ts
it('builds tools URL from origin when LLM_BASE_URL ends with /v1', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
  const client = new DeepSeekToolsClient({
    apiKey: 'sk-test',
    baseURL: 'https://api.deepseek.com/v1',
    fetchImpl: fetchMock,
  });
  await client.search({ query: 'hello', count: 1 });
  expect(fetchMock.mock.calls[0][0]).toBe(
    'https://api.deepseek.com/v1/tools/search',
  );
});

it('forwards abortSignal to fetch', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
  const ac = new AbortController();
  const client = new DeepSeekToolsClient({
    apiKey: 'sk-test',
    baseURL: 'https://api.deepseek.com/v1',
    fetchImpl: fetchMock,
  });
  await client.search({ query: 'hello' }, ac.signal);
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: ac.signal });
});
```

- [ ] **Step 3: 实现 Client + module factory**

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
    // POST JSON；Authorization Bearer；signal 传入 fetch
    // 4xx：抛带中文信息的 Error（tools 层捕获后返回 { error }）
    // 429/5xx：最多再重试 1 次；仍失败则抛
  }

  async fetchPage(
    body: DeepSeekFetchRequest,
    signal?: AbortSignal,
  ): Promise<DeepSeekFetchResponse> {
    // 同上
  }
}
```

`chat.module.ts`：

```ts
{
  provide: DeepSeekToolsClient,
  useFactory: (config: ConfigService) =>
    new DeepSeekToolsClient({
      apiKey: config.getOrThrow<string>('LLM_API_KEY'),
      baseURL: config.getOrThrow<string>('LLM_BASE_URL'),
    }),
  inject: [ConfigService],
},
```

计费判定留给上层：Client 只返回结果；`results.length===0` / 空 `content` 由 tools 层决定不计费。

- [ ] **Step 4: 补空结果 / 4xx 测；跑通；提交**

```bash
npx vitest run src/chat/llm/deepseek-tools.client.spec.ts
git add src/chat/llm/deepseek-tools.* src/chat/chat.module.ts
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

- [ ] **Step 1: 写 URL 提取失败测**

```ts
expect(extractUrlsFromText('看 https://a.com/x。还有 http://b.com')).toEqual([
  'https://a.com/x',
  'http://b.com',
]);
expect(extractUrlsFromText('无链接')).toEqual([]);
```

匹配 `https?://` 开头、去掉尾部中文标点；返回去重数组。

- [ ] **Step 2: 实现 URL 提取并跑绿**

- [ ] **Step 3: createWebTools 测（优先，先红）**

覆盖：

1. search 超 `CHAT_WEB_SEARCH_MAX_PER_TURN` 不调 client，返回 `{ error: '...' }`（中文）
2. fetch URL 不在白名单 → 不调 client，返回 `{ error: '只能抓取本轮用户给出的链接或搜索结果中的链接' }`（**不抛**，避免 500）
3. 用户消息 URL 在白名单可 fetch
4. 成功 search 后 `billableSearchCount++` 且 `results.length>0`
5. fetch 成功：content 截断至 `maxChars`，外包 `<untrusted_web_content url="...">...</untrusted_web_content>`；sources 项 `fetched: true` 且 title 可覆盖
6. `data-webSearch`：`searching` → `done`（或 `error`）顺序经同一 `writeQueue`
7. 成功 search/fetch 后幂等重写 `data-webSources`

- [ ] **Step 4: 实现 `createWebTools(ctx)`**

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
writer.write({ type: 'data-webSearch', data: { status, query, errorText? } });
writer.write({ type: 'data-webFetch', data: { status, url, title?, errorText? } });
```

- `web_search` / `web_fetch`：`tool({ description, inputSchema: jsonSchema(...), execute })`
- **abort：** `execute` 内优先用 SDK `options.abortSignal`（`ToolExecutionOptions`），**不要**再手工把外层 `abortController.signal` 塞进 `createWebTools` 参数
- 预占计数（同步 `++` 后再 await HTTP）
- `ori_question`：码点截断用户原问
- 工具失败语义统一：`return { error: '中文原因' }`（模型可改写 query）；禁止未捕获抛错导致整轮 500
- 每次成功 search/fetch 更新 sources，经 `enqueueWrite(() => writer.write({ type: 'data-webSources', data: { sources } }))`

返回 `{ tools, session }` 供 stream 结束读计数。

- [ ] **Step 5: 跑测提交**

```bash
npx vitest run src/chat/llm/extract-urls-from-text.spec.ts src/chat/llm/create-web-tools.spec.ts
git commit -m "feat(chat): 实现 web_search/web_fetch 工具与白名单"
```

---

### Task 6: ChatStreamService 集成

**Files:**

- Create: `src/chat/llm/chat-model.factory.ts`
- Modify: `src/chat/chat-stream.service.ts`
- Modify: `src/chat/chat-stream.service.spec.ts`
- Modify: `src/chat/llm/deepseek-provider.replay.spec.ts`
- Modify: `src/chat/chat.module.ts`

**先决（P0-3 / P0-4 / P1-7）：改实现前先改 mock 与 seam，否则现有 20+ 用例集体红。**

- [ ] **Step 0a: 抽出 `ChatModelFactory` 并注册**

```ts
// src/chat/llm/chat-model.factory.ts
@Injectable()
export class ChatModelFactory {
  create(opts: Parameters<typeof createLanguageModel>[0]) {
    return createLanguageModel(opts);
  }
}
```

`ChatStreamService` 注入 `ChatModelFactory` + `DeepSeekToolsClient`，**删除**对 `createLanguageModel` 的直接调用。`chat.module.ts` 增加 `ChatModelFactory` provider。

单测：把 `vi.mock('./llm/create-language-model.js')` 改为提供 `ChatModelFactory` mock（`{ create: createLanguageModelMock }`），或 `providers: [{ provide: ChatModelFactory, useValue: { create: createLanguageModelMock } }]`。

- [ ] **Step 0b: 更新 `chat-stream.service.spec.ts` 的 `ai` mock（P0-3）**

现有 `vi.mock('ai')` 只有 4 个导出；实现一 `import { isStepCount, tool, jsonSchema }` 就会让全部用例 `undefined is not a function`。二选一（**推荐 A**）：

**A（推荐）**— mock 补导出 + 单测侧 `vi.mock('./llm/create-web-tools.js')`：

```ts
const isStepCountSentinel = Symbol('isStepCount');
vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => streamTextMock(...args),
  pipeUIMessageStreamToResponse: (...args: unknown[]) => pipeMock(...args),
  toUIMessageStream: (...args: unknown[]) => toUIMessageStreamMock(...args),
  createUIMessageStream: (...args: unknown[]) =>
    createUIMessageStreamMock(...args),
  isStepCount: (n: number) => ({ __stopWhen: 'isStepCount', n }),
  tool: vi.fn((def) => def),
  jsonSchema: vi.fn((schema) => schema),
}));

vi.mock('./llm/create-web-tools.js', () => ({
  createWebTools: vi.fn(() => ({
    tools: { web_search: {}, web_fetch: {} },
    session: {
      billableSearchCount: 0,
      billableFetchCount: 0,
      sources: [],
      // …其余字段按需
    },
  })),
}));
```

**B**— 只补 `ai` mock 导出，让真实 `createWebTools` 跑（需再 mock Client；更重，不推荐本层）。

- [ ] **Step 0c: 更新 billing mock（P0-4）**

现有 mock 缺方法 → 一调即 TypeError。在 `beforeEach` 的 `billing` 上补：

```ts
computeWebToolsCostMicros: vi.fn().mockReturnValue(0n),
getWebToolPrices: vi.fn().mockReturnValue({ search: 5000n, fetch: 5000n }),
```

- [ ] **Step 1: 改 `buildModelMessages`（并替换旧断言 P0-5）**

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

`reasoningContent` 为空/`null`：**不**捏造 reasoning part（空串契约留给 provider 层，见 Step 4b）。

限额：最近 `CHAT_WEB_REASONING_HISTORY_TURNS`（默认 4）条含 CoT；单条 `CHAT_WEB_REASONING_MAX_CHARS`（默认 4000）码点截断。

**删除/替换** `chat-stream.service.spec.ts` 中现有用例  
`buildModelMessages does not put historical reasoning into model messages`（约 L549，断言 `not.toContain(secretCot)`）——与新行为正面冲突。改为两条：

1. 最近 N 条内含 CoT → model messages **包含**该 reasoning 文本
2. 超出轮数或单条超字符上限 → **不包含**被裁掉的全文（可断言截断后前缀或完全缺失更早轮）

- [ ] **Step 2: `stream` 内注册 tools**

```ts
import { isStepCount, streamText, ... } from 'ai';
// tool/jsonSchema 只在 create-web-tools.ts 使用

const maxSteps = Number(this.configService.get('CHAT_WEB_TOOL_MAX_STEPS', '8'));
const stepMaxTokens = Number(
  this.configService.get('CHAT_WEB_STEP_MAX_TOKENS', '2048'),
);
const userText = this.extractLastUserText(dto.messages);

let session: WebToolsSession | undefined; // execute 抛错时 finally 须判空

const result = streamText({
  model: this.modelFactory.create({ /* 原 createLanguageModel 参数 */ }),
  messages: modelMessages,
  tools, // 在 execute 内 createWebTools 后得到
  stopWhen: isStepCount(maxSteps),
  maxOutputTokens: stepMaxTokens, // 每步上限；多步最坏 ≈ steps×本值（成本提示见 .env.example）
  abortSignal: abortController.signal,
  onFinish: ({ usage }) => {
    lastUsage = usage; // 只取 usage，禁止用 onFinish.text 落库
  },
});
```

注意：

- `writer` 仅在 `execute` 内可用 → `createWebTools` 须在 `execute` 回调里创建；`session` 外层 `let`
- `toUIMessageStream({ stream, tools, ... })` **必须**传同一套 `tools`
- 注入的 `this.toolsClient` 传给 `createWebTools`，勿 `new DeepSeekToolsClient`

- [ ] **Step 3: persist 硬约束**

`onEnd`：`extractUiMessageText(responseMessage)` → 正文/CoT；`mapLanguageModelUsage(lastUsage)` → token；  
`webToolsCost = this.billing.computeWebToolsCostMicros(session?.billableSearchCount ?? 0, session?.billableFetchCount ?? 0)`；  
写入 `sources`、counts、`webToolsCostMicros`、`costMicros = token + web`。

abort/`finally`：若尚未成功 persist，且（`session` 有 billable web **或**已有文本），同样 persist（usage 可全 0）。**`session` 未创建（execute 早抛）时不得解引用。**

`persistOnce`：建议 **await DB 成功后再置 `persisted = true`**（或失败可再试一次），避免本轮已产生真金白银却因先置位导致永不入账。

- [ ] **Step 4a: ChatStreamService 单测**

1. 断言 `streamText` 收到 `stopWhen` 等价于 `isStepCount(maxSteps)`，且 `tools` 非空；改 env `CHAT_WEB_TOOL_MAX_STEPS=3` 时 `n === 3`
2. 历史有 CoT（限额内）：messages 含 `{ type: 'reasoning', text }`（见 Step 1 替换用例）
3. 历史无 CoT：`buildModelMessages` **不**产生 reasoning part（不在本层断言 HTTP payload）
4. abort：**与正常完成路径**均调用 `incrementWeeklySpend` / `recordSpend`，且 web cost 来自 `computeWebToolsCostMicros`
5. 落库文本来自 `onEnd` 累计 message，**禁止**用 `onFinish.text`
6. 本轮工具过程**不**因累计费用触发硬 429（开流前硬拦保留）

- [ ] **Step 4b: Provider 层契约（P0-2）— 复用 `deepseek-provider.replay.spec.ts`**

该文件已捕获 `requestBody`。新增一例：messages 含 **无 reasoning** 的 assistant + 注册任意 tools（或最小 tool）→ 解析 body 后断言对应 assistant 消息存在 `reasoning_content === ""`（字段存在且空串）。**不要**在已 mock 掉 `ai` 的 `chat-stream.service.spec.ts` 里做 payload 断言。

- [ ] **Step 5: 跑测提交**

```bash
npx vitest run src/chat/chat-stream.service.spec.ts src/chat/llm/deepseek-provider.replay.spec.ts
git commit -m "feat(chat): 流式对话接入 Search/Fetch 工具与来源落库"
```

---

### Task 7: Messages API 返回 `sources`

**Files:**

- Modify: `src/chat/chat-messages.service.ts`
- Create: `src/chat/chat-messages.service.spec.ts`（仓库目前无此文件；按 AGENTS 补上）

- [ ] **Step 1: 写单测（先红）**

```ts
it('returns sources on assistant; omits cost/count fields', async () => {
  // mock prisma message with sources + webSearchCount + webToolsCostMicros
  const page = await service.list(userId, conversationId, {});
  expect(page.items[0].sources).toEqual([
    { title: 't', url: 'https://a.com', snippet: 's' },
  ]);
  expect(page.items[0]).not.toHaveProperty('webSearchCount');
  expect(page.items[0]).not.toHaveProperty('webToolsCostMicros');
  expect(page.items[0]).not.toHaveProperty('costMicros');
});

it('user messages expose sources as null', async () => {
  expect(page.items.find((m) => m.role === 'user')?.sources).toBeNull();
});
```

- [ ] **Step 2:** `MessageDto` 增加 `sources: WebSource[] | null`；list 映射 `row.sources ?? null`（金额/count **永不**进 DTO）
- [ ] **Step 3:** 跑测并提交 `feat(chat): 消息历史返回 sources`

---

### Task 8: e2e + 前端文档

**Files:**

- Modify: `test/chat.e2e-spec.ts`
- Modify: `docs/chat-api-frontend.md`

**定案（P0-1 方案 A）：** e2e 的 `LLM_BASE_URL` 是假地址；**只 override Client 不够**——必须同时 override `ChatModelFactory` 返回固定 `text-delta` 的假 `LanguageModel`，否则 `streamText` 仍打 `llm.example.com`，无文本。

- [ ] **Step 1: e2e override 双 seam**

```ts
const fakeModel = /* AI SDK 兼容 stub：doStream 产出 text-delta + finish */;

moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(ChatModelFactory)
  .useValue({ create: () => fakeModel })
  .overrideProvider(DeepSeekToolsClient)
  .useValue({
    search: vi.fn().mockResolvedValue({ results: [] }),
    fetchPage: vi.fn().mockResolvedValue({ title: '', content: '' }),
  })
  .compile();
```

断言：认证后 stream **200**，响应体含 text delta / 非空助手文本。保留既有 401/404。  
（真网「无 CoT + tools 不 400」仍归 Task 9，不在 e2e。）

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

| Spec 要求                                                                                | Task        |
| ---------------------------------------------------------------------------------------- | ----------- |
| origin 工具 URL / 无双 `/v1`                                                             | 3           |
| Nest provider 可 override（Client + ModelFactory）                                       | 3, 6, 8     |
| `isStepCount` / 默认非 1；`CHAT_WEB_TOOL_MAX_STEPS`                                      | 6           |
| 历史 CoT 回传 + 限额（替换旧 not.toContain 用例）                                        | 6           |
| 无 CoT：`buildModelMessages` 不捏造 + **provider.replay** `reasoning_content==""` + 真网 | 6 Step4b, 9 |
| sources 幂等 data part；截断/untrusted/中文错误                                          | 5           |
| abort **与正常路径**记 web 费                                                            | 6           |
| fetch 8k + 白名单含用户 URL                                                              | 5           |
| env 三件套 + URL 校验 + 每步 token 上限                                                  | 1           |
| 落库 onEnd / usage onFinish；session 判空                                                | 6           |
| Message 列 + 历史 DTO + messages.spec                                                    | 2, 7        |
| 计费合并周预算                                                                           | 4, 6        |
| e2e：假模型 + Client override → 200+文本                                                 | 8           |
| 前端文档                                                                                 | 8           |

## Placeholder scan

无 TBD/TODO；P0 测试/DI 路径已写明可执行步骤。
