# DeepSeek 联网搜索（Search + Fetch）— Design Spec

**日期：** 2026-10-22  
**分支：** `feature/deepseek-web-search`  
**状态：** 待实现（brainstorming 已对齐）

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

非目标（本轮不做）：

- 不改走 Responses API / 不强制升级 `deepseek-v4-pro`
- 不做用户侧「强制联网」开关（模型自行决定是否调用工具；下轮若要可再加）
- 不把 Search/Fetch 金额字段暴露给 `GET /chat/quota`（仍只返回百分比）

官方参考：

- [网页搜索与抓取指南](https://api-docs.deepseek.com/zh-cn/guides/search/)
- [Search API](https://api-docs.deepseek.com/zh-cn/api/search/)
- [Fetch API](https://api-docs.deepseek.com/zh-cn/api/fetch/)

---

## 决策摘要

| 议题        | 选择                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------- |
| 接入路径    | 方案 A：AI SDK `streamText` + 服务端 tools，封装 `/v1/tools/search` 与 `/v1/tools/fetch` |
| 触发方式    | 模型 Function Calling（始终注册两工具；模型决定是否调用）                                |
| 每轮上限    | search ≤ 2，fetch ≤ 3；超限返回工具错误、不打官方 API、不计费                            |
| Search 正文 | 默认 `need_content=false`；正文靠 `web_fetch`                                            |
| 前端体验    | 过程态 + 来源列表（data parts）                                                          |
| 来源持久化  | 助手消息落库 `sources` JSON；历史接口带回                                                |
| 计费        | 成功 Search/Fetch 按次计入周预算；单价可配置                                             |
| 超支策略    | 开流前硬拦（与现网一致）；本轮工具过程中软限制（跑完本轮，下轮再拦）                     |
| 正文格式    | 协议仍为 text parts；模型常输出 Markdown，前端按 Markdown 渲染（现状不变）               |

---

## 架构

```text
客户端 useChat
  → POST /chat/conversations/:id/messages/stream
  → ChatStreamService.streamText({ tools: web_search, web_fetch, ... })
       ├─ tool web_search → DeepSeekToolsClient.search() → POST /v1/tools/search
       ├─ tool web_fetch  → DeepSeekToolsClient.fetch()  → POST /v1/tools/fetch
       ├─ writer data-webSearch / data-webFetch / data-webSources
       └─ persist assistant message (content + sources + costMicros)
```

鉴权：复用 `LLM_API_KEY` + `LLM_BASE_URL`（默认 `https://api.deepseek.com`）。不新增第二套 Key，除非后续产品要求拆分。

---

## 官方 API 类型（准确 Schema）

> 来源：[Search](https://api-docs.deepseek.com/zh-cn/api/search/) · [Fetch](https://api-docs.deepseek.com/zh-cn/api/fetch/) · [指南](https://api-docs.deepseek.com/zh-cn/guides/search/)  
> 字段名为 **snake_case**。Base URL：`https://api.deepseek.com`。鉴权：`Authorization: Bearer <API Key>`。

### Search — `POST /v1/tools/search`

**Request body**

| 字段           | 类型             | 必填 | 默认     | 约束 / 说明                                                                                        |
| -------------- | ---------------- | ---- | -------- | -------------------------------------------------------------------------------------------------- |
| `query`        | `string`         | 是   | —        | 非空，≤128 Unicode，不能全空白；支持 `site:` / `-site:` / 引号 / `lang:` / `after:` / `before:` 等 |
| `count`        | `integer`        | 否   | **`10`** | 1～**50**                                                                                          |
| `ori_question` | `string \| null` | 否   | —        | 非空时 1～128；传 `null` 视为未提供                                                                |
| `localization` | `string`         | 否   | `""`     | 用于本地化的 **IP 地址**                                                                           |
| `need_content` | `boolean`        | 否   | `false`  | 为 `false` 时结果里 `content` 恒为 `""`                                                            |

未知字段会被忽略。

**Response body（HTTP 200）**

```ts
/** 官方 Search 成功响应 */
type DeepSeekSearchResponse = {
  results: DeepSeekSearchResult[]; // 无匹配时为 []
};

type DeepSeekSearchResult = {
  /** 排序分 0～3；≥1.5 为优质 */
  rerank_score: number;
  title: string;
  url: string;
  /** 短摘要，约 100～200 字符，偏 UI */
  snippet: string;
  /** 长摘要，约 600～800 字符，偏给模型读 */
  summary: string;
  /** need_content=false 或正文缺失时为 "" */
  content: string;
  site_name: string | null;
  site_icon: string | null;
  /** UTC RFC 3339；未知为 null */
  date: string | null;
  /** -1～4；≥3 极权威；-1 未知 */
  authority: number;
};
```

### Fetch — `POST /v1/tools/fetch`

**Request body**

| 字段  | 类型     | 必填 | 约束 / 说明                                                    |
| ----- | -------- | ---- | -------------------------------------------------------------- |
| `url` | `string` | 是   | ≤8192；含 host 的 `http`/`https`；**不能**带 username/password |

**Response body（HTTP 200）**

```ts
/** 官方 Fetch 成功响应 */
type DeepSeekFetchResponse = {
  /** 缺失时为 "" */
  title: string;
  /** Markdown 正文 */
  content: string;
};
```

### 错误与计费（官方）

错误体为 OpenAI 兼容格式：`{ error: { message, type, param: null, code } }`。

| HTTP      | 说明                                                    |
| --------- | ------------------------------------------------------- |
| 400       | 请求不合法                                              |
| 401       | Key 无效                                                |
| 402       | 余额不足                                                |
| 403       | Fetch 被安全策略拒绝                                    |
| 404       | Fetch 拿不到可用正文（URL/策略/类型/无可提取 Markdown） |
| 408 / 413 | 读 body 超时 / 过大                                     |
| 429       | Search 或 Fetch QPS（账号级；Fetch 另有域名级）         |
| 500 / 504 | 服务端 / 下游超时                                       |

计费：Search、Fetch 各 **¥5 / 1000 次成功请求**。仅 HTTP 200 且「有结果」才计费（Search：`results` 非空；Fetch：有网页正文）。失败、空结果、超时不计费。QPS：Search 100、Fetch 25（账号级，互相独立）。

---

## 工具契约（本产品封装）

在官方 Schema 之上，用 AI SDK `tool()` 暴露给模型的名称：`web_search` / `web_fetch`。HTTP 客户端与官方字段一一对应（snake_case）。

### `web_search`

| 项           | 说明                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 官方         | `POST {LLM_BASE_URL}/v1/tools/search`                                                                                                             |
| 模型入参     | `query` 必填；`count` 可选                                                                                                                        |
| 请求体映射   | `{ query, count, ori_question?: 用户原问截断至 ≤128, need_content: false }`；本轮默认不传 `localization`                                          |
| `count` 策略 | 未传时用配置默认值（对齐官网默认 **10**）；传入后 clamp 到 `1..min(50, CHAT_WEB_SEARCH_COUNT_CAP)`，产品硬顶默认 **≤10**（小于官网 50，控上下文） |
| 成功回传模型 | 完整 `DeepSeekSearchResponse`（或精简掉空 `content`）；优先让模型读 `summary`，UI 用来源时用 `snippet`                                            |
| 计费条件     | HTTP 200 且 `results.length > 0` → +`CHAT_PRICE_WEB_SEARCH_MICROS`                                                                                |

### `web_fetch`

| 项           | 说明                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------ |
| 官方         | `POST {LLM_BASE_URL}/v1/tools/fetch`                                                       |
| 模型入参     | `url` 必填（校验 http/https、有 host、无 userinfo、≤8192）                                 |
| 成功回传模型 | `DeepSeekFetchResponse`；`content` 在入模前按 `CHAT_WEB_FETCH_MAX_CHARS`（默认 30000）截断 |
| 计费条件     | HTTP 200 且 `content` 非空 → +`CHAT_PRICE_WEB_FETCH_MICROS`                                |

### 上限与错误

- 本轮计数器：`searchCount` / `fetchCount`；达上限后工具返回中文错误（如「本轮搜索次数已达上限」），**不请求官方、不计费**。
- 官方 4xx（不可重试）/ 空结果：工具返回可读错误；模型可改写 query 或直接回答。
- 官方 429 / 5xx / 超时：最多再试 **1** 次；仍失败则返回错误文案。
- 工具失败 **不得** 导致整轮 HTTP 500；助手仍可输出无来源回答。

---

## 流式协议（前端）

在现有 AI SDK UI Message Stream 上增加 data parts（名称固定，便于前端订阅）：

| type              | 时机               | data 示例                                                                                  |
| ----------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `data-webSearch`  | 搜索开始/结束/失败 | `{ status: 'searching'\|'done'\|'error', query: string, errorText?: string }`              |
| `data-webFetch`   | 抓取开始/结束/失败 | `{ status: 'fetching'\|'done'\|'error', url: string, title?: string, errorText?: string }` |
| `data-webSources` | 本轮结束前至多一次 | `{ sources: WebSource[] }`                                                                 |

`WebSource`：

```ts
type WebSource = {
  title: string;
  url: string;
  snippet: string;
  siteName?: string | null;
  fetched?: boolean;
};
```

来源列表组装规则：

1. 以本轮成功 `web_search` 的结果为主（去重按 `url`）
2. 若某 url 被成功 `web_fetch`，标记 `fetched: true`，可用 fetch 的 `title` 覆盖空标题
3. 仅 fetch、无 search 时：用 fetch 的 `title/url`，`snippet` 可取 content 前 200 字符

正文仍走现有 `text` / `reasoning` parts；前端继续 Markdown 渲染。

---

## 数据模型

### `Message` 扩展

| 字段                 | 类型                         | 说明                                                              |
| -------------------- | ---------------------------- | ----------------------------------------------------------------- |
| `sources`            | `Json?`（默认 `[]` 或 null） | `WebSource[]`；用户消息恒为空/null                                |
| `webSearchCount`     | `Int` 默认 0                 | 本条助手消息对应轮次中 **计费成功** 的 search 次数                |
| `webFetchCount`      | `Int` 默认 0                 | 同上 fetch                                                        |
| `webToolsCostMicros` | `BigInt` 默认 0              | 本轮联网按次费用（微元）                                          |
| `costMicros`         | 已有                         | **改为** `tokenCostMicros + webToolsCostMicros`（落库时写入合计） |

迁移：新增列；存量行默认 0 / 空。无需回填历史来源。

历史接口 `GET /chat/conversations/:id/messages`：助手消息 DTO **仅增加 `sources`**。`webSearchCount` / `webFetchCount` / `webToolsCostMicros` 落库供对账，**不**进入对外 DTO（额度仍只通过 `/chat/quota` 百分比体现）。

---

## 计费

### 单价（官方 ¥5 / 1000 次成功请求）

| 环境变量                        | 默认    | 含义                                        |
| ------------------------------- | ------- | ------------------------------------------- |
| `CHAT_PRICE_WEB_SEARCH_MICROS`  | `5000`  | 一次成功 Search = ¥0.005                    |
| `CHAT_PRICE_WEB_FETCH_MICROS`   | `5000`  | 一次成功 Fetch = ¥0.005                     |
| `CHAT_WEB_FETCH_MAX_CHARS`      | `30000` | fetch 正文截断（入模前）                    |
| `CHAT_WEB_SEARCH_DEFAULT_COUNT` | `10`    | search 默认条数（对齐官网）                 |
| `CHAT_WEB_SEARCH_COUNT_CAP`     | `10`    | 单次 search `count` 产品上限（官网最大 50） |
| `CHAT_WEB_SEARCH_MAX_PER_TURN`  | `2`     | 每轮 search 调用次数上限                    |
| `CHAT_WEB_FETCH_MAX_PER_TURN`   | `3`     | 每轮 fetch 调用次数上限                     |

### 入账路径

1. **开流前**：`getWeeklySpendMicros` vs `getWeeklyBudgetMicros`；已满 → **429**（与现网一致）。
2. **工具执行中**：仅对「计费成功」累加本轮 `webToolsCostMicros`；**不**在工具中间写 Redis/DB（避免半成功难回滚）；软限制不中断本轮。
3. **落库**：`tokenCost = computeCostMicros(usage)`；`total = tokenCost + webToolsCost`；同一事务写 message + `incrementWeeklySpend(total)`，事务外 `recordSpend(total)`。

对账字段：`webSearchCount` / `webFetchCount` / `webToolsCostMicros` 与 `costMicros` 一并落库。

---

## 模块切分（实现指引）

| 模块                  | 职责                                                                    |
| --------------------- | ----------------------------------------------------------------------- |
| `DeepSeekToolsClient` | HTTP 调用 search/fetch；错误映射；超时                                  |
| `createWebTools(...)` | AI SDK `tool()` 定义；计数器；写 data parts；累计计费次数               |
| `ChatStreamService`   | 注册 tools、maxSteps/stopWhen、persist sources + costs                  |
| `ChatBillingService`  | 读取联网单价；提供 `computeWebToolsCostMicros(searchCount, fetchCount)` |
| Messages DTO / e2e    | 返回 `sources`；流式契约单测                                            |

`maxSteps`：需足够覆盖「最多 2 search + 3 fetch + 最终文本」；建议可配置，默认 ≥ 8，并与工具上限一致，避免无限循环。

---

## 测试计划（最低）

- `DeepSeekToolsClient`：成功 / 空结果 / 4xx / 429 重试（mock HTTP）
- tools：达上限不再请求；成功才累加计费计数
- stream：发出 `data-webSearch` / `data-webFetch` / `data-webSources`；persist 含 sources 与合计 cost
- billing：`webToolsCost` 进入周 spend；quota 百分比反映合并消耗
- e2e（可 mock 工具客户端）：带 tools 的一轮流式不 500

---

## 前端对接要点

1. 订阅 UI Message Stream 的 `data-webSearch` / `data-webFetch` 展示过程态
2. 用 `data-webSources` 或历史里的 `sources` 渲染来源卡片（title + url + snippet）
3. 正文继续走 text parts → Markdown
4. 本轮后端始终注册工具；无需新的请求 body 字段（若下轮加开关再扩展 DTO）

---

## 发布与风险

- Search/Fetch QPS 独立（官方：Search 100、Fetch 25）；应用层已有每轮上限，一般够用
- 按次计费叠加 token，短对话也可能更快触及周预算——属预期
- 抓取受目标站策略影响（403/404）；需保证工具错误可被模型消化
- 与前端同批发布来源/过程 UI 体验最佳；旧前端可忽略未知 data parts，仅少过程态
