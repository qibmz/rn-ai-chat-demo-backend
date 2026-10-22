# DeepSeek 联网搜索（Search + Fetch）— Design Spec

**日期：** 2026-10-22  
**分支：** `feature/deepseek-web-search`  
**状态：** 待实现（brainstorming 已对齐；按外部 review / 复审修订 P0–P2）

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

| 议题         | 选择                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| 接入路径     | 方案 A：AI SDK `streamText` + 服务端 tools，封装官方 Search/Fetch        |
| 触发方式     | 模型 Function Calling（始终注册两工具；模型决定是否调用）                |
| 每轮上限     | search ≤ 2，fetch ≤ 3；超限返回工具错误、不打官方 API、不计费            |
| Search 正文  | 默认 `need_content=false`；正文靠 `web_fetch`                            |
| 前端体验     | 过程态 + 来源列表（data parts）                                          |
| 来源持久化   | 助手消息 `sources Json?` 默认 **`null`**；历史接口带回                   |
| 计费         | 成功按次计入周预算；**abort 也记已发生费用**                             |
| 超支策略     | 开流前硬拦；本轮工具过程中软限制                                         |
| 工具 URL     | 从 `LLM_BASE_URL` **取 origin** 再拼 `/v1/tools/...`（避免双 `/v1`）     |
| 多步循环     | `stopWhen: isStepCount(8)`（**不是**已移除的 `maxSteps`）                |
| 历史 CoT     | 注册 tools 时回传已落库 CoT；无 CoT 存量路径须契约 + 真网验证            |
| 落库正文/CoT | **硬约束**：取 `onEnd.responseMessage`；`onFinish` **只**取 `usage`      |
| fetch 安全   | 白名单 = **当前用户消息 URL ∪ 本轮 search 结果 URL**；正文不可信边界包裹 |
| fetch 截断   | 默认 **8000** 字符                                                       |
| 正文格式     | 协议仍为 text parts；前端按 Markdown 渲染                                |

---

## 架构

```text
客户端 useChat
  → POST /chat/conversations/:id/messages/stream
  → ChatStreamService.streamText({
        tools, stopWhen: isStepCount(8), abortSignal, ...
     })
       ├─ buildModelMessages：assistant 历史带 reasoning（限额内）
       ├─ allowedFetchUrls ← 用户消息 URL ∪ search 结果
       ├─ tool web_search / web_fetch
       ├─ writer 队列：data-webSearch / data-webFetch / data-webSources
       └─ persist（含 abort）：onEnd 文本 + usage + webToolsCost
```

鉴权：复用 `LLM_API_KEY` + `LLM_BASE_URL`。

### `LLM_BASE_URL` 与工具 URL（P0-1）

仓库现状（保留，供 Chat Completions）：

```ini
LLM_BASE_URL=https://api.deepseek.com/v1
```

工具客户端：

```ts
function toolsApiOrigin(llmBaseUrl: string): string {
  return new URL(llmBaseUrl).origin; // https://api.deepseek.com
}
// POST `${origin}/v1/tools/search` | `/v1/tools/fetch`
```

`env.validation`：**`LLM_BASE_URL` 必须是合法 `http:`/`https:` URL**（可被 `new URL` 解析），非法则启动失败。

---

## 官方 API 类型（准确 Schema）

> [Search](https://api-docs.deepseek.com/zh-cn/api/search/) · [Fetch](https://api-docs.deepseek.com/zh-cn/api/fetch/) · [指南](https://api-docs.deepseek.com/zh-cn/guides/search/)  
> 字段 **snake_case**。

### Search — `POST /v1/tools/search`

| 字段           | 类型             | 必填 | 默认     | 约束                        |
| -------------- | ---------------- | ---- | -------- | --------------------------- |
| `query`        | `string`         | 是   | —        | ≤128 **码点**，非空非全空白 |
| `count`        | `integer`        | 否   | **`10`** | 1～**50**                   |
| `ori_question` | `string \| null` | 否   | —        | 非空时 1～128 码点          |
| `localization` | `string`         | 否   | `""`     | IP                          |
| `need_content` | `boolean`        | 否   | `false`  |                             |

```ts
type DeepSeekSearchResponse = { results: DeepSeekSearchResult[] };

type DeepSeekSearchResult = {
  rerank_score: number; // 0～3；≥1.5 优质
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  site_name: string | null;
  site_icon: string | null;
  date: string | null; // UTC RFC 3339
  authority: number; // 0～4，**-1 = 未知**
};
```

截断用 `Array.from(s).slice(0, n).join('')`。

### Fetch — `POST /v1/tools/fetch`

| 字段  | 类型     | 必填 | 约束                             |
| ----- | -------- | ---- | -------------------------------- |
| `url` | `string` | 是   | ≤8192；http(s)+host；无 userinfo |

```ts
type DeepSeekFetchResponse = { title: string; content: string /* Markdown */ };
```

计费：各 ¥5/1000 次成功；QPS Search 100 / Fetch 25。

---

## 工具契约（本产品封装）

AI SDK v7：`tool({ description, inputSchema, execute })`，`import { jsonSchema } from 'ai'`（**不新增 zod**）。

### `web_search`

| 项      | 说明                                                             |
| ------- | ---------------------------------------------------------------- |
| HTTP    | `POST ${origin}/v1/tools/search`                                 |
| 入参    | `query` 必填；`count` 可选                                       |
| 请求体  | `{ query, count, ori_question?: 码点≤128, need_content: false }` |
| `count` | 默认 10；clamp `1..min(50, CHAT_WEB_SEARCH_COUNT_CAP)`           |
| 计费    | 200 且 `results.length > 0`                                      |
| 副作用  | url → `allowedFetchUrls`；幂等重写 `data-webSources`             |

### `web_fetch`

| 项         | 说明                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| HTTP       | `POST ${origin}/v1/tools/fetch`                                                                           |
| 入参       | `url` ∈ **`allowedFetchUrls`**                                                                            |
| 白名单初始 | ① **当前用户消息**中解析的 http(s) URL；② 成功 search 的 url。用户粘贴链接可直接抓；模型编造域外 URL 仍拦 |
| 非白名单   | 不请求；错误「只能抓取本轮用户给出的链接或搜索结果中的链接」；不计费                                      |
| 回传       | 截断至默认 8000；`<untrusted_web_content url="...">...</untrusted_web_content>`                           |
| 计费       | 200 且 `content` 非空                                                                                     |

### 上限、并发与 abort

- `searchCount` / `fetchCount`：**原子预占**，防并行绕过 ≤2 / ≤3。
- **并行时序（接受）**：同 step search∥fetch 时，fetch 可能早于 search → 白名单未就绪 → 被拒；模型下一步可重试。不做复杂预扫描。
- **data part 单一写队列**：避免并行 search 交错乱序。
- 工具 HTTP 透传 `abortSignal`。
- 工具失败不得整轮 500。

### 多步循环（P0-2）

```ts
import { streamText, isStepCount } from 'ai';

streamText({
  stopWhen: isStepCount(8), // 不设则默认 isStepCount(1)
  // ...
});
```

取 8：2 search + 3 fetch + 收尾留余量；env `CHAT_WEB_TOOL_MAX_STEPS` 可覆盖。

命名：类型导出为 **`isStepCount`**；运行时另有同函数别名 `stepCountIs`。**实现用 `isStepCount`**。

`toUIMessageStream({ stream, tools, ... })`：**必须传同一套 `tools`**。

### 落库硬约束（P2-3）

| 来源                              | 用途                                        |
| --------------------------------- | ------------------------------------------- |
| `onFinish.usage`                  | 跨 step **聚合** token → 计费 ✅            |
| `onFinish.text` / `reasoningText` | **仅 final step** → **禁止**落库            |
| `onEnd.responseMessage`           | 全步累计 UI message → **唯一**正文/CoT 来源 |

abort/失败路径同样：累计文本 + 已发生 `webToolsCostMicros` 一并落库。

---

## 历史 reasoning（P0-3）

官方：带 `tools` 时历史 `reasoning_content` 须回传，否则可能 400。

1. DB 有非空 `reasoningContent` → AI SDK `type: 'reasoning'` part 带回。
2. **存量高频**：`reasoningContent=null`。不捏造；依赖 provider 发 `reasoning_content: ""`。**契约断言该字段存在且为空串 + 真网 Key 跑一轮确认不 400**；不成立则阻塞「始终挂 tools」（降级：无 CoT 历史关 thinking / 不挂 tools）。
3. 同轮多步：SDK 自带本轮 reasoning。
4. **成本限额**：最近 `CHAT_WEB_REASONING_HISTORY_TURNS`（默认 **4**）条含 CoT 的助手消息；单条超 `CHAT_WEB_REASONING_MAX_CHARS`（默认 **4000** 码点）截断。额度掉得更快属预期。

---

## 流式协议（前端）

| type              | 时机                              | data                                  |
| ----------------- | --------------------------------- | ------------------------------------- |
| `data-webSearch`  | 开始/结束/失败                    | `{ status, query, errorText? }`       |
| `data-webFetch`   | 开始/结束/失败                    | `{ status, url, title?, errorText? }` |
| `data-webSources` | 成功 search/fetch 后 **幂等重写** | `{ sources: WebSource[] }`            |

`onEnd` 无 writer → 不承诺收尾只发一次；前端始终用最新 `data-webSources`。

```ts
type WebSource = {
  title: string;
  url: string;
  snippet: string;
  siteName?: string | null;
  fetched?: boolean;
};
```

---

## 数据模型

| 字段                 | 类型                    | 说明            |
| -------------------- | ----------------------- | --------------- |
| `sources`            | `Json?` 默认 **`null`** | `WebSource[]`   |
| `webSearchCount`     | `Int` 默认 0            | 计费成功 search |
| `webFetchCount`      | `Int` 默认 0            | 计费成功 fetch  |
| `webToolsCostMicros` | `BigInt` 默认 0         | 联网微元        |
| `costMicros`         | 已有                    | `token + web`   |

**迁移：** 新增列；存量 `sources=null`、计数/费用 0；**无需回填**历史来源或 CoT。

对外历史 DTO **只加 `sources`**。

---

## 计费与配置

| 环境变量                           | 默认   | 含义                                                    |
| ---------------------------------- | ------ | ------------------------------------------------------- |
| `CHAT_PRICE_WEB_SEARCH_MICROS`     | `5000` | ¥0.005 / 成功 Search                                    |
| `CHAT_PRICE_WEB_FETCH_MICROS`      | `5000` | ¥0.005 / 成功 Fetch                                     |
| `CHAT_WEB_FETCH_MAX_CHARS`         | `8000` | fetch 入模截断                                          |
| `CHAT_WEB_SEARCH_DEFAULT_COUNT`    | `10`   | 对齐官网                                                |
| `CHAT_WEB_SEARCH_COUNT_CAP`        | `10`   | 与 DEFAULT 相同时无额外收紧；调低 DEFAULT 或 CAP 才有差 |
| `CHAT_WEB_SEARCH_MAX_PER_TURN`     | `2`    |                                                         |
| `CHAT_WEB_FETCH_MAX_PER_TURN`      | `3`    |                                                         |
| `CHAT_WEB_TOOL_MAX_STEPS`          | `8`    | `isStepCount(N)`                                        |
| `CHAT_WEB_REASONING_HISTORY_TURNS` | `4`    | 回传含 CoT 的最近助手轮数                               |
| `CHAT_WEB_REASONING_MAX_CHARS`     | `4000` | 单条历史 CoT 码点上限                                   |

**同批必做：** `.env.example` + `env.validation`（含 `LLM_BASE_URL` URL 格式）+ 单测。

### 入账

1. 开流前硬拦 → 429。
2. 工具中只累加内存计数/费用。
3. 正常结束 **与 abort**：web 费用必入账；token 用 `onFinish.usage`；正文用 `onEnd.responseMessage`。
4. `costMicros = token + web`。

---

## 模块切分

| 模块                      | 职责                                                     |
| ------------------------- | -------------------------------------------------------- |
| `DeepSeekToolsClient`     | origin、HTTP、重试、abortSignal                          |
| `createWebTools`          | tools、白名单、原子计数、写队列、计费累计                |
| `ChatStreamService`       | `isStepCount`、历史 reasoning、落库硬约束、abort persist |
| `ChatBillingService`      | `computeWebToolsCostMicros`                              |
| 配置 / Messages DTO / e2e | env 三件套、`sources`、流式契约                          |

---

## 测试计划（最低）

1. Client：成功/空/4xx/429；**base 带 `/v1` 不双拼**
2. tools：上限；非白名单拒；**用户消息 URL 可 fetch**；成功计费；并发不超限
3. stream：三 data part；写队列不乱序
4. **多步最终有正文**；落库文本非 final-step-only
5. 历史**有** CoT + tools：发出 messages 含 reasoning part
6. 历史**无** CoT（`null`）+ tools：断言 `reasoning_content` 存在且 `""`；**真网 Key 确认不 400**（失败则阻塞始终挂 tools）
7. abort：web 费用仍入账
8. billing / quota
9. e2e mock：200 且有文本
10. `env.validation`：非法 `LLM_BASE_URL` 启动失败

---

## 前端对接要点

1. 过程态：`data-webSearch` / `data-webFetch`
2. 来源：最新 `data-webSources`；历史 `sources`
3. 正文：text → Markdown
4. 无需新 stream body 字段

---

## 发布与风险

- QPS + 每轮上限一般够用；abort 透传降浪费
- 白名单含用户 URL，兼顾安全与「总结这篇链接」
- 并行 fetch 偶发白名单拒属预期
- 旧前端可忽略未知 data parts
- 「无 CoT 历史 + tools」真网验证是上线前门禁
