# AI SDK Provider 流式接入设计

**日期：** 2026-10-12  
**状态：** 待用户审阅  
**分支：** `feature/deepseek-chat`  
**选定方案：** A — 薄工厂 + 官方 `@ai-sdk/*` provider，业务层统一 `streamText`

## 背景

当前流式路径使用自研 `runLlmChatStream` 解析 SSE。根因是曾误用 `@ai-sdk/openai`（不读 `reasoning_content`），导致思考链丢失后用自研补洞。

官方 `@ai-sdk/deepseek` 已正确解析 `delta.reasoning_content` → `reasoning-delta`，并支持 `thinking` / `reasoningEffort`。自研 SSE 应删除。

## 目标

1. 业务层只使用 AI SDK：`streamText` → `toUIMessageStream` → `pipeUIMessageStreamToResponse`。
2. 换模型 = 换 `model`（及对应 `providerOptions`），不改流式业务骨架。
3. 删除自研 SSE / provider profiles / OpenAI 消息手写转换。
4. 保留与 provider 无关的能力：周额度、并发锁、消息落库、abort 落盘、附件直传、`data-chatMeta`。

## 非目标

- 本迭代不实现 OpenAI / 其它厂商工厂分支的完整生产路径（可留清晰的「未实现」错误）。
- 不改前端 useChat 契约（仍为 UI Message Stream）。
- 不改附件直传、额度账本模型。

## 架构

```text
ChatStreamService
  ├─ 业务：额度 / 并发 / 落库 / abort 持久化 / data-chatMeta
  ├─ createLanguageModel({ provider, apiKey, baseURL, modelId })
  │     └─ deepseek → createDeepSeek(...).chat(modelId)
  └─ streamText({ model, messages, maxOutputTokens, abortSignal, providerOptions })
        └─ toUIMessageStream({ sendReasoning }) → UI Message Stream
```

### 工厂职责（唯一随厂商变化的点）

| Provider           | 包                 | 构造                                                |
| ------------------ | ------------------ | --------------------------------------------------- |
| `deepseek`（默认） | `@ai-sdk/deepseek` | `createDeepSeek({ apiKey, baseURL }).chat(modelId)` |
| 其它               | —                  | 本迭代抛出明确中文错误（未实现）                    |

DeepSeek 专用选项通过 `providerOptions.deepseek` 传入：

```ts
providerOptions: {
  deepseek: {
    thinking: { type: thinking ? 'enabled' : 'disabled' },
    reasoningEffort: thinking ? reasoningEffort : undefined,
  },
}
```

### 环境变量（保持中性名）

| 变量           | 说明                                                 |
| -------------- | ---------------------------------------------------- |
| `LLM_PROVIDER` | 默认 `deepseek`；枚举含 deepseek（本迭代仅实现此项） |
| `LLM_API_KEY`  | 必填                                                 |
| `LLM_BASE_URL` | 必填（例：`https://api.deepseek.com/v1`）            |
| `LLM_MODEL`    | 必填（例：`deepseek-flash`）                         |

可删除或停止使用：自研路径引入的 `llm-provider-profiles` 中 qwen/glm/doubao 思考参数映射（改由各官方 provider 负责）。

## 流式行为要求

1. **思考链：** `sendReasoning: thinking`；由 `@ai-sdk/deepseek` 产出 `reasoning-*` 帧。
2. **输出上限：** `maxOutputTokens` ← `CHAT_MAX_TOKENS`；依赖 DeepSeek provider 使用 `max_tokens`（不再手写改写请求体）。
3. **完成落库：** `streamText` 的 `onFinish`：文本、`reasoningText`、usage、finishReason → `persistAssistantMessage`。
4. **中断落库：** `onAbort`（或等价路径）：落盘已有部分文本/思考与可用 usage，`finishReason='aborted'`。不得只依赖 `onFinish`。
5. **Usage → 计费：** 从 AI SDK `LanguageModelUsage` 映射到现有 `ChatUsageForBilling`（cache hit/miss、completion 扣除 reasoning 的既有规则保持）。

## 删除清单

- `src/chat/utils/llm-chat-stream.util.ts` (+ `.spec.ts`)
- `src/chat/utils/openai-compatible-sse.util.ts` (+ `.spec.ts`)
- `src/chat/utils/llm-provider-profiles.ts` (+ `.spec.ts`)
- `src/chat/utils/model-messages-to-openai.util.ts`

## 新增 / 修改清单

- 新增：`src/chat/llm/create-language-model.ts` (+ 单测)
- 修改：`src/chat/chat-stream.service.ts` — 改回 AI SDK 流式；去掉 `runLlmChatStream`
- 修改：`src/chat/chat-stream.service.spec.ts` — mock `ai` + `@ai-sdk/deepseek`
- 修改：`README.md`、`.env.example`（说明官方 provider 工厂；去掉自研 SSE 描述）
- 依赖：保留 `@ai-sdk/deepseek` + `ai`；不重新引入 `@ai-sdk/openai`（直到真正需要 OpenAI 分支）

## 测试策略（TDD）

1. **工厂：** `deepseek` 返回可调用 chat model；未知 provider 抛错。
2. **流式服务：** mock `streamText` / `toUIMessageStream` / `createDeepSeek`；断言传入的 `providerOptions.deepseek`、`maxOutputTokens`、`sendReasoning`；`onFinish` / `onAbort` 触发落库。
3. **不再**维护自研 SSE 分片回放单测（随文件删除）。

## 风险与缓解

| 风险                                    | 缓解                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| DeepSeek provider 默认 thinking=enabled | 显式传 `thinking.type`                                                                       |
| abort 时 SDK 不调 onFinish              | 必须接 `onAbort` 或 createUIMessageStream 结算回调                                           |
| 图片 `providerOptions` 字段名           | 查 `@ai-sdk/deepseek` 的 file/image options（`deepseek.imageDetail` 等），与 openai 命名解耦 |

## 成功标准

- [ ] 无自研 SSE 解析代码
- [ ] 开启 thinking 时 UI Message Stream 含 `reasoning-*`（由官方包产出）
- [ ] abort 后半截回答与用量落库
- [ ] `LLM_*` 配置可指向 DeepSeek；换 OpenAI 时只需扩展工厂 + 加依赖
- [ ] lint / typecheck / unit tests 全绿

## Spec 自检

- 无 TBD / 占位实现路径
- 与「方案 A」用户批准一致
- 范围未扩大到附件/额度重构
- 与现有 `LLM_*` env 命名兼容
