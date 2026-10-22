# DeepSeek 联网搜索（Search + Fetch）— Design Spec

**日期：** 2026-10-22  
**分支：** `feature/deepseek-web-search`  
**状态：** 待实现（brainstorming 已对齐；按外部 review 修订 P0/P1）

## 背景与目标

产品需要让助手在必要时联网查资料并抓取正文，再生成回答。DeepSeek 官方提供两条能力：

1. **独立工具 API**：`POST /v1/tools/search`、`POST /v1/tools/fetch`（按次计费，Bearer 与模型 Key 相同）
2. **Responses API 内置 `web_search`**：服务端执行，但 **仅 `deepseek-v4-pro` 支持**；`deepseek-flash` 下忽略

本仓库流式链路是 **AI SDK `streamText` + Chat Completions 风格 + `deepseek-flash`**，与 Responses 内置联网不兼容。因此本轮采用 **模型 Function Calling + 服务端封装官方 Search/Fetch**。

本轮目标：

1. 模型可调用 `web_search` / `web_fetch`（内部打 DeepSeek 官方工具 API）
2. 每轮硬顶：search ≤ 2、fetch ≤ 3
3. 流式向前端暴露「搜索/抓取过程」与「来源列表」
4. 来源落库，历史消息可回放
5. 成功的 Search/Fetch 按次费用计入现有周预算（与 token 费用合并）
6. 带 tools 时按官方要求回传历史 `reasoning_content`（已落库的 CoT）

非目标（本轮不做）：

- 不改走 Responses API / 不强制升级 `deepseek-v4-pro`
- 不做用户侧「强制联网」开关（模型自行决定是否调用工具；下轮若要可再加）
- 不把 Search/Fetch 金额字段暴露给 `GET /chat/quota`（仍只返回百分比）

官方参考：

- [网页搜索与抓取指南](https://api-docs.deepseek.com/zh-cn/guides/search/)
- [Search API](https://api-docs.deepseek.com/zh-cn/api/search/)
- [Fetch API](https://api-docs.deepseek.com/zh-cn/api/fetch/)
- [思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)
- [Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api)

---

## 决策摘要

| 议题        | 选择                                                                     |
| ----------- | ------------------------------------------------------------------------ |
| 接入路径    | 方案 A：AI SDK `streamText` + 服务端 tools，封装官方 Search/Fetch        |
| 触发方式    | 模型 Function Calling（始终注册两工具；模型决定是否调用）                |
| 每轮上限    | search ≤ 2，fetch ≤ 3；超限返回工具错误、不打官方 API、不计费            |
| Search 正文 | 默认 `need_content=false`；正文靠 `web_fetch`                            |
| 前端体验    | 过程态 + 来源列表（data parts）                                          |
| 来源持久化  | 助手消息 `sources Json?` 默认 **`null`**；历史接口带回                   |
| 计费        | 成功 Search/Fetch 按次计入周预算；单价可配置；**abort 也记账已发生费用** |
| 超支策略    | 开流前硬拦；本轮工具过程中软限制                                         |
| 工具 URL    | 从 `LLM_BASE_URL` **取 origin** 再拼 `/v1/tools/...`（避免双 `/v1`）     |
| 多步循环    | `stopWhen: isStepCount(8)`（**不是**已移除的 `maxSteps`）                |
| 历史 CoT    | 注册 tools 时，助手历史消息必须带回已落库的 `reasoningContent`           |
| fetch 安全  | 仅允许本轮 `web_search` 返回过的 URL；正文按不可信内容包裹               |
| fetch 截断  | 默认 **8000** 字符（控 token；最多 3 次 ≈ 24k 字符）                     |
| 正文格式    | 协议仍为 text parts；前端按 Markdown 渲染                                |

---

## 架构

```text
客户端 useChat
  → POST /chat/conversations/:id/messages/stream
  → ChatStreamService.streamText({
        tools, stopWhen: isStepCount(8), abortSignal, ...
     })
       ├─ buildModelMessages：assistant 历史带 reasoning（若有）
       ├─ tool web_search → DeepSeekToolsClient.search()
       ├─ tool web_fetch  → DeepSeekToolsClient.fetch()（URL 白名单）
       ├─ writer：data-webSearch / data-webFetch / data-webSources（幂等重写）
       └─ persist（含 abort）：content + sources + tokenCost + webToolsCost
```

鉴权：复用 `LLM_API_KEY` + `LLM_BASE_URL`。不新增第二套 Key。

### `LLM_BASE_URL` 与工具 URL（P0-1）

仓库现状（保留，供 Chat Completions / `@ai-sdk/deepseek`）：

```ini
LLM_BASE_URL=https://api.deepseek.com/v1
```

工具客户端 **不得** 再拼一层 `/v1`：

```ts
function toolsApiOrigin(llmBaseUrl: string): string {
  return new URL(llmBaseUrl).origin; // https://api.deepseek.com
}
// POST `${toolsApiOrigin(base)}/v1/tools/search`
// POST `${toolsApiOrigin(base)}/v1/tools/fetch`
```

单测覆盖：`.../v1` 与 `.../`（无 path）两种 base 都能得到正确 tools URL。

---

## 官方 API 类型（准确 Schema）

> 来源：[Search](https://api-docs.deepseek.com/zh-cn/api/search/) · [Fetch](https://api-docs.deepseek.com/zh-cn/api/fetch/) · [指南](https://api-docs.deepseek.com/zh-cn/guides/search/)  
> 字段名为 **snake_case**。鉴权：`Authorization: Bearer <API Key>`。

### Search — `POST /v1/tools/search`

| 字段           | 类型             | 必填 | 默认     | 约束 / 说明                                          |
| -------------- | ---------------- | ---- | -------- | ---------------------------------------------------- |
| `query`        | `string`         | 是   | —        | 非空，≤128 **码点**，不能全空白；支持 `site:` 等语法 |
| `count`        | `integer`        | 否   | **`10`** | 1～**50**                                            |
| `ori_question` | `string \| null` | 否   | —        | 非空时 1～128 码点；`null`=未提供                    |
| `localization` | `string`         | 否   | `""`     | 本地化用的 IP                                        |
| `need_content` | `boolean`        | 否   | `false`  | `false` 时 `content` 恒为 `""`                       |

```ts
type DeepSeekSearchResponse = {
  results: DeepSeekSearchResult[]; // 无匹配时为 []
};

type DeepSeekSearchResult = {
  /** 0～3；≥1.5 优质 */
  rerank_score: number;
  title: string;
  url: string;
  snippet: string; // 短摘要，偏 UI
  summary: string; // 长摘要，偏模型
  content: string; // need_content=false 或缺失时为 ""
  site_name: string | null;
  site_icon: string | null;
  date: string | null; // UTC RFC 3339
  /** 权威性：0～4，**-1 表示未知**（不是「-1～4 连续区间」的口语混写） */
  authority: number;
};
```

`ori_question` / `query` 截断用码点：`Array.from(s).slice(0, 128).join('')`，禁止按 UTF-16 `string.slice`。

### Fetch — `POST /v1/tools/fetch`

| 字段  | 类型     | 必填 | 约束                                      |
| ----- | -------- | ---- | ----------------------------------------- |
| `url` | `string` | 是   | ≤8192；含 host 的 http/https；无 userinfo |

```ts
type DeepSeekFetchResponse = {
  title: string; // 缺失时为 ""
  content: string; // Markdown
};
```

### 错误与计费（官方）

| HTTP            | 说明                        |
| --------------- | --------------------------- |
| 400 / 401 / 402 | 请求不合法 / Key / 余额     |
| 403 / 404       | Fetch 安全拒绝 / 无可用正文 |
| 408 / 413 / 429 | 超时 / 过大 / QPS           |
| 500 / 504       | 服务端 / 下游超时           |

计费：各 **¥5 / 1000 次成功**；仅 200 且有结果。QPS：Search 100、Fetch 25。

---

## 工具契约（本产品封装）

AI SDK v7：`tool({ description, inputSchema, execute })`，schema 用 `import { jsonSchema } from 'ai'`（**不新增 zod 依赖**）。

### URL 派生

| 工具         | HTTP                             |
| ------------ | -------------------------------- |
| `web_search` | `POST ${origin}/v1/tools/search` |
| `web_fetch`  | `POST ${origin}/v1/tools/fetch`  |

### `web_search`

| 项       | 说明                                                                                         |
| -------- | -------------------------------------------------------------------------------------------- |
| 模型入参 | `query` 必填；`count` 可选                                                                   |
| 请求体   | `{ query, count, ori_question?: 码点截断≤128, need_content: false }`                         |
| `count`  | 默认 `CHAT_WEB_SEARCH_DEFAULT_COUNT=10`；clamp 到 `1..min(50, CHAT_WEB_SEARCH_COUNT_CAP=10)` |
| 回传模型 | `DeepSeekSearchResponse`（可去掉空 `content`）；模型优先读 `summary`                         |
| 计费     | 200 且 `results.length > 0` → +`CHAT_PRICE_WEB_SEARCH_MICROS`                                |
| 副作用   | 将结果 `url` 加入本轮 `allowedFetchUrls`；幂等重写 `data-webSources`                         |

### `web_fetch`

| 项       | 说明                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 模型入参 | `url` 必填（形状校验 + **必须 ∈ 本轮 `allowedFetchUrls`**）                                                                                                                    |
| 非白名单 | 不请求官方；工具返回错误「只能抓取本轮搜索结果中的链接」；不计费                                                                                                               |
| 回传模型 | `{ title, content }`；`content` 截断至 `CHAT_WEB_FETCH_MAX_CHARS`（默认 **8000**），并用明确边界包裹，例如：`<untrusted_web_content url="...">\n...\n</untrusted_web_content>` |
| 计费     | 200 且 `content` 非空 → +`CHAT_PRICE_WEB_FETCH_MICROS`                                                                                                                         |

### 上限、并发与 abort

- 计数器 `searchCount` / `fetchCount`：**同一 step 内可能并行 tool call**，自增与上限判断须原子（如同步临界区 / 预占名额），防止并发绕过 ≤2 / ≤3。
- 达上限：中文错误，不打官方、不计费。
- 官方 429/5xx/超时：最多再试 1 次。
- 工具内 HTTP **透传** `streamText` 的 `abortSignal`，客户端断开后不再继续打官方。
- 工具失败不得导致整轮 HTTP 500。

### 多步循环（P0-2）

AI SDK v7 **无 `maxSteps`**。必须显式：

```ts
import { streamText, isStepCount } from 'ai';

streamText({
  // ...
  stopWhen: isStepCount(8), // 默认若不设则为 isStepCount(1)，只会跑 1 步
});
```

**取 8 的依据：** 最多 2 search + 3 fetch + 若干中间/收尾文本步 ≥ 6，留余量取 8；可用 env `CHAT_WEB_TOOL_MAX_STEPS` 覆盖（默认 8）。

`toUIMessageStream({ stream, tools, sendReasoning, ... })`：**必须传入同一套 `tools`**，避免前端工具 part 退化成 dynamic。

---

## 历史 reasoning（P0-3）

官方：请求带 `tools` 时，历史轮 `reasoning_content` 须完整回传，否则可能 400。

本仓库现状刻意不回传历史 CoT；本轮改为：

1. **始终注册 tools** ⇒ `buildModelMessages` 对 `role=assistant`：若 DB 有非空 `reasoningContent`，以 AI SDK reasoning part（或 provider 可识别的 assistant reasoning）带回；可见正文仍用 `content`。
2. 无历史 CoT 的旧消息：不捏造；依赖 provider 行为（空串）。实现后用 **真网或契约测试** 确认「仅空串历史 + tools」不 400；若仍 400，再评估是否对无 CoT 历史关闭 thinking / 降级。
3. **同轮内**多步：AI SDK 会保留本轮 reasoning，无需额外处理。

---

## 流式协议（前端）

| type              | 时机                                                       | data                                                               |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `data-webSearch`  | 搜索开始/结束/失败                                         | `{ status: 'searching'\|'done'\|'error', query, errorText? }`      |
| `data-webFetch`   | 抓取开始/结束/失败                                         | `{ status: 'fetching'\|'done'\|'error', url, title?, errorText? }` |
| `data-webSources` | **每次成功 search（及成功 fetch 更新 fetched）后幂等重写** | `{ sources: WebSource[] }`                                         |

> `createUIMessageStream` 的 `onEnd` **没有 writer**；`execute` 在 `merge` 后即返回。因此 **不** 承诺「收尾只发一次」，改为工具侧维护累计列表并重写最新快照；前端始终以最新 `data-webSources` 为准。

```ts
type WebSource = {
  title: string;
  url: string;
  snippet: string;
  siteName?: string | null;
  fetched?: boolean;
};
```

组装：search 结果为主（按 url 去重）；成功 fetch 标 `fetched: true` 并可补 title。

---

## 数据模型

| 字段                 | 类型                    | 说明                             |
| -------------------- | ----------------------- | -------------------------------- |
| `sources`            | `Json?` 默认 **`null`** | `WebSource[]`；用户消息保持 null |
| `webSearchCount`     | `Int` 默认 0            | 计费成功的 search 次数           |
| `webFetchCount`      | `Int` 默认 0            | 计费成功的 fetch 次数            |
| `webToolsCostMicros` | `BigInt` 默认 0         | 联网按次费用                     |
| `costMicros`         | 已有                    | `tokenCost + webToolsCost`       |

对外历史 DTO **只加 `sources`**。

---

## 计费

| 环境变量                        | 默认       | 含义                   |
| ------------------------------- | ---------- | ---------------------- |
| `CHAT_PRICE_WEB_SEARCH_MICROS`  | `5000`     | ¥0.005 / 次成功 Search |
| `CHAT_PRICE_WEB_FETCH_MICROS`   | `5000`     | ¥0.005 / 次成功 Fetch  |
| `CHAT_WEB_FETCH_MAX_CHARS`      | **`8000`** | fetch 入模截断         |
| `CHAT_WEB_SEARCH_DEFAULT_COUNT` | `10`       | 对齐官网默认           |
| `CHAT_WEB_SEARCH_COUNT_CAP`     | `10`       | 单次 count 产品上限    |
| `CHAT_WEB_SEARCH_MAX_PER_TURN`  | `2`        | 每轮 search 次数       |
| `CHAT_WEB_FETCH_MAX_PER_TURN`   | `3`        | 每轮 fetch 次数        |
| `CHAT_WEB_TOOL_MAX_STEPS`       | `8`        | `isStepCount(N)`       |

**配置落地（同批必做）：** `.env.example` + `env.validation.ts`（`optionalNonNegativeInt` / 正整数）+ `env.validation` 相关单测。

### 入账路径

1. 开流前：周预算硬拦 → 429。
2. 工具执行中：只累加内存中的 `webToolsCostMicros` / counts（成功才加）；不中途写 Redis/DB。
3. **正常结束与 abort/失败落盘**：只要本轮已产生计费成功的 search/fetch，**必须**把 `webToolsCostMicros`（及 counts、sources 快照）写入助手消息，并 `incrementWeeklySpend` + `recordSpend`。abort 时 token usage 可为 0，但 **web 费用不得漏记**。
4. `costMicros = tokenCost + webToolsCost`。

Token 成本提示：3×8000 字符量级仍可能抬高 prompt；属可控预期，短对话也可能更快触及周预算。

---

## 模块切分

| 模块                  | 职责                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `DeepSeekToolsClient` | origin 派生、search/fetch HTTP、错误映射、超时、`abortSignal`、有限重试                   |
| `createWebTools(...)` | `tool`+`inputSchema`；原子计数；白名单；data parts；累计计费                              |
| `ChatStreamService`   | `stopWhen: isStepCount`；历史 reasoning；`toUIMessageStream({ tools })`；abort 也 persist |
| `ChatBillingService`  | `computeWebToolsCostMicros(searchCount, fetchCount)`                                      |
| 配置                  | `.env.example` + `env.validation` + 单测                                                  |
| Messages DTO / e2e    | `sources`；流式契约                                                                       |

---

## 测试计划（最低）

1. `DeepSeekToolsClient`：成功 / 空结果 / 4xx / 429 重试；**base URL 带 `/v1` 不双拼**
2. tools：达上限不请求；非白名单 fetch 不请求；成功才计费；并发不超过上限
3. stream：`data-webSearch` / `data-webFetch` / `data-webSources` 幂等更新
4. **多步循环最终产出助手正文**（防 `isStepCount(1)` 回归）
5. **带 tools + thinking：历史含 `reasoningContent` 的请求不 400**（mock 或回放断言发出的 messages）
6. abort：已发生 web 费用仍入账
7. billing / quota：web 费用进入周 spend
8. e2e（mock 工具客户端）：一轮流式 200 且有文本

---

## 前端对接要点

1. 过程态：`data-webSearch` / `data-webFetch`
2. 来源：始终用**最新** `data-webSources`；历史用消息 `sources`
3. 正文：text parts → Markdown
4. 无需新的 stream body 字段

---

## 发布与风险

- QPS 与每轮上限一般够用；abort 透传降低浪费
- fetch 白名单 + 不可信边界降低外带与注入面，不保证消除
- 旧前端可忽略未知 data parts
- 与前端同批上线过程/来源 UI 体验最佳
