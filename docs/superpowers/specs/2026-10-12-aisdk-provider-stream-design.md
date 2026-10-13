# AI SDK Provider 流式接入设计

**日期：** 2026-10-12  
**状态：** 修订定稿（吸收 review）  
**分支：** `feature/deepseek-chat`  
**选定方案：** A — 薄工厂 + 官方 `@ai-sdk/*` provider，业务层统一 `streamText`

## 背景

当前未提交工作树里，流式走自研 `runLlmChatStream`（含手工 `reasoning-*` 与 `persistOnce` abort 落盘）。根因是曾误用 `@ai-sdk/openai`（不读 `reasoning_content`）。

官方 `@ai-sdk/deepseek` 已解析 `delta.reasoning_content` → `reasoning-delta`，并支持 `thinking` / `reasoningEffort` / `userId` / `imageDetail`。应删除自研 SSE，改回 AI SDK 标准通路，同时**不得回退**已修好的 abort 落盘与思考链能力。

## 目标

1. 业务层只使用 AI SDK：`streamText` → `toUIMessageStream` → `createUIMessageStream` → `pipeUIMessageStreamToResponse`。
2. 换模型 = 换 `model`（及对应 `providerOptions`），不改流式业务骨架。
3. 删除全部自研 SSE / provider profiles / 手写 OpenAI 消息转换（含对应 spec）。
4. 保留：周额度、并发锁、消息落库、**全终结态落盘**、附件直传、`data-chatMeta`。

## 非目标

- 本迭代不实现 OpenAI 等其它厂商完整分支（工厂对未知 provider 抛中文「未实现」）。
- 不改前端 useChat 契约。
- 不改附件直传、额度账本 schema。
- **不把历史 `reasoningContent` 塞回模型上下文**（见下）。

## 架构

```text
ChatStreamService
  ├─ 业务：额度 / 并发 / data-chatMeta / persistOnce（幂等）
  ├─ createLanguageModel({ provider, apiKey, baseURL, modelId })
  │     └─ deepseek（默认）→ createDeepSeek(...).chat(modelId)
  ├─ streamText({ model, messages, maxOutputTokens, abortSignal, providerOptions,
  │               onFinish → 仅捕获 usage 到闭包变量 })
  └─ createUIMessageStream({
        execute: writer.write(data-chatMeta) + merge(toUIMessageStream({ sendReasoning })),
        onEnd → 唯一落盘入口（含 abort / 失败 / 正常结束）
      })
```

### 工厂

| Provider               | 包                 | 行为                                                |
| ---------------------- | ------------------ | --------------------------------------------------- |
| `deepseek`（**默认**） | `@ai-sdk/deepseek` | `createDeepSeek({ apiKey, baseURL }).chat(modelId)` |
| 其它                   | —                  | 抛出明确中文错误：`暂不支持的 LLM_PROVIDER: …`      |

默认值必须是 `deepseek`，禁止回落到 `openai-compatible`（会撞「未实现」）。

### DeepSeek `providerOptions`（约定写法）

```ts
providerOptions: {
  deepseek: {
    thinking: { type: thinking ? 'enabled' : 'disabled' },
    // 仅 thinking=true 时传入；禁止传 'none'（类型不合法，关思考只靠 thinking.type）
    ...(thinking ? { reasoningEffort } : {}),
    // KVCache / 内容安全隔离；UUID 字符集合法（[a-zA-Z0-9_-]）
    userId: userId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 512) || 'anonymous',
  },
}
```

图片 detail 使用 DeepSeek 字段，不用 openai 命名：

```ts
providerOptions: {
  deepseek: {
    imageDetail: 'low' | 'high' | 'original' | 'auto';
  }
}
```

`reasoningEffort` 运行时 schema 另有 `medium` / `xhigh`，但导出 TS 类型仅为 `'low'|'high'|'max'`。本项目 DTO/env 只允许这三者。

### 历史消息 → 模型上下文（硬约定）

- Assistant 只传 `content`（可见回复文本）。
- **不**把 `reasoningContent` / reasoning parts 放进 `messages`。
- 原因：`@ai-sdk/deepseek` 对 V4（含 `deepseek-flash`）会自行处理 `reasoning_content`；若业务再塞入历史思考，会进入 prompt、抬高成本，并与「无 tools 不回传旧 CoT」定稿相悖。包在缺省时会给 V4 assistant 注入空串 `reasoning_content: ''`，无需业务回传旧 CoT 即可避免 400。

## 落盘与 Usage（代码级约定，二选一已定）

**唯一落盘入口：`createUIMessageStream({ onEnd })`。**  
不采用 `streamText.onFinish` 落盘，也不采用 `onFinish + onAbort` 双写。

依据：`handleUIMessageStreamFinish` 在 abort / 客户端取消 / 失败 / 正常结束时都会调 `onEnd`，并提供 `isAborted`、`outcome`、`responseMessage`（含 text / reasoning parts）。`streamText` 在 abort 时**不**调 `onFinish`。

### Usage 来源（写死）

| 终结态       | 文本 / 思考                                       | usage                                                                                    |
| ------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 正常结束     | `onEnd.responseMessage` 的 text / reasoning parts | `streamText.onFinish` 写入闭包 `lastUsage`（正常结束必有）                               |
| abort / 取消 | 同上（部分内容）                                  | `lastUsage` 多为 `null`（abort 常无完整 usage）→ 按 0 计费入库，`finishReason='aborted'` |
| 流错误       | 若有部分内容仍落盘                                | 有则用 `lastUsage`，否则 0                                                               |

```ts
let lastUsage: LanguageModelUsage | undefined;
let persisted = false;

const persistOnce = async (args) => {
  if (persisted) return;
  persisted = true;
  await persistAssistantMessage(args);
};

streamText({
  /* ... */
  onFinish: ({ usage }) => {
    lastUsage = usage;
  },
});

createUIMessageStream({
  execute: ({ writer }) => {
    writer.write({
      type: 'data-chatMeta',
      data: { userMessageId, assistantMessageId, quota: null },
    });
    writer.merge(
      toUIMessageStream({
        stream: result.stream,
        sendReasoning: thinking,
        generateMessageId: () => assistantMessageId,
      }),
    );
  },
  onEnd: async ({ isAborted, responseMessage }) => {
    const { text, reasoningText } = extractFromUiMessage(responseMessage);
    await persistOnce({
      text,
      reasoningText,
      finishReason: isAborted
        ? 'aborted'
        : /* 从 outcome/finish 推导，缺省 stop */ 'stop',
      usage: lastUsage ?? null,
      /* ... */
    });
  },
});
```

`persistOnce` 必须幂等（abort 与错误路径不得双写）。

## 环境变量（破坏性迁移，同批改完）

| 变量           | 说明                                           |
| -------------- | ---------------------------------------------- |
| `LLM_PROVIDER` | 默认 **`deepseek`**；校验枚举至少含 `deepseek` |
| `LLM_API_KEY`  | 必填                                           |
| `LLM_BASE_URL` | 必填                                           |
| `LLM_MODEL`    | 必填                                           |

**同批修改（不做 `DEEPSEEK_*` 回退别名）：**

- `.env.example`
- `src/common/config/env.validation.ts` (+ spec)
- `vitest.config.e2e.ts`
- `README.md`
- 开发者本地 `.env`（文档注明手动改名）

工作树若已部分切到 `LLM_*`，以本表为准收齐。

## 删除清单（完整）

- `src/chat/utils/llm-chat-stream.util.ts`
- `src/chat/utils/llm-chat-stream.util.spec.ts`
- `src/chat/utils/openai-compatible-sse.util.ts`
- `src/chat/utils/openai-compatible-sse.util.spec.ts`
- `src/chat/utils/llm-provider-profiles.ts`
- `src/chat/utils/llm-provider-profiles.spec.ts`
- `src/chat/utils/model-messages-to-openai.util.ts`（无独立 spec）

## 新增 / 修改清单

- 新增：`src/chat/llm/create-language-model.ts` (+ `.spec.ts`)
- 可选：`src/chat/llm/extract-ui-message-text.ts`（从 UIMessage parts 抽 text/reasoning）
- 修改：`chat-stream.service.ts` — AI SDK 流式 + `onEnd` 落盘 + DeepSeek `providerOptions`（含 `userId`、图片 `imageDetail`）
- 修改：`chat-stream.service.spec.ts` — 业务 mock + **data-chatMeta / onEnd abort 幂等** 断言
- 新增：`src/chat/llm/deepseek-provider.replay.spec.ts` — **真实 `@ai-sdk/deepseek` + 假 SSE fetch 回放**（不 mock 掉 provider 解析）
- 文档与 env 迁移文件见上

## 测试策略（可证伪）

1. **工厂单测**
   - `deepseek` 返回可调用 language model
   - 未知 provider 抛中文「暂不支持」

2. **真实 provider 回放（守住思考链 / max_tokens）**
   - `createDeepSeek({ apiKey: 'x', baseURL: 'http://example.invalid', fetch: mockFetch })`
   - `mockFetch` 返回 `text/event-stream`，分片含 `delta.reasoning_content` 与末包 `usage`
   - 经 `streamText`（或 provider `doStream`）断言产出 **`reasoning-delta`**
   - 断言请求 JSON 含 **`max_tokens`**（非 `max_completion_tokens`）与 **`thinking`**

3. **流式服务（可 mock `ai` 编排，但落盘路径要测）**
   - 断言 `execute` 写入 **`data-chatMeta`**（含 `userMessageId` / `assistantMessageId`）
   - 模拟 `onEnd({ isAborted: true, responseMessage })` → `persistAssistantMessage` **恰好一次**，`finishReason='aborted'`
   - 正常 `onEnd` + 预设 `lastUsage` → 落库带 usage / 周额度

4. **历史上下文**
   - `buildModelMessages`（或等价）单测：assistant 行只有文本 content，parts/messages 不含历史 reasoning

## 风险与缓解

| 风险                                            | 缓解                                 |
| ----------------------------------------------- | ------------------------------------ |
| abort 无 usage                                  | 接受软限制下本轮记 0；文档与实现一致 |
| DeepSeek 默认 thinking=enabled                  | 显式 `thinking.type`                 |
| 历史 CoT 进 prompt                              | 硬约定不传 reasoning part            |
| 全 mock 掩盖 provider bug                       | 强制回放测试（策略 2）               |
| `data-chatMeta` 在改用 toUIMessageStream 后丢失 | 显式回归断言                         |
| env 半迁移导致 CI fail-fast                     | 同批改完 LLM_*，无别名               |

## 成功标准（可执行）

- [ ] `createLanguageModel`：deepseek 可用；未知 provider 抛中文错
- [ ] 真实 provider 假 SSE 回放：产出 `reasoning-delta`；请求体含 `max_tokens` 与 `thinking`
- [ ] `onEnd(isAborted: true)` → 落库一次且 `finishReason='aborted'`（幂等）
- [ ] 流中仍有 `data-chatMeta`（含两个 message id）
- [ ] 历史 assistant 不回传 reasoning 到模型
- [ ] 自研 SSE 文件全部删除
- [ ] lint / typecheck / unit tests 全绿

## Spec 自检

- 落盘入口已二选一写死为 `createUIMessageStream.onEnd`（非 TBD）
- usage 来源已写死（`streamText.onFinish` 闭包 + abort 可为 null）
- 含真实 provider 回放测试要求
- LLM_* 为破坏性同批迁移，非「兼容别名」
- 含 `userId` / `imageDetail` / 历史不回传 CoT / `reasoningEffort` 禁 `none`
- 默认 provider = `deepseek`
- 删除清单含全部相关 `.spec.ts`
