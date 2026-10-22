# Task 6 Report: ChatStreamService 集成

## Status

**DONE**

## What landed

- `ChatModelFactory` 薄封装 `createLanguageModel`，并在 `ChatModule` 注册。
- `ChatStreamService` 改为注入 `ChatModelFactory` + `DeepSeekToolsClient`，不再直接调用 `createLanguageModel`。
- `execute` 内 `createWebTools`；`streamText` 使用同一套 `tools`、`stopWhen: isStepCount(CHAT_WEB_TOOL_MAX_STEPS)`（默认 8）、每步 `maxOutputTokens = CHAT_WEB_STEP_MAX_TOKENS`（默认 2048）。
- `toUIMessageStream` 传入同一 `tools`。
- 历史 CoT：最近 `CHAT_WEB_REASONING_HISTORY_TURNS`（默认 4）条**含 CoT** 的助手消息回传 `{ type: 'reasoning', text }`，单条按码点截到 `CHAT_WEB_REASONING_MAX_CHARS`（默认 4000）。空/`null` 不捏造 reasoning part。无 CoT 的助手不占用名额。
- 落库：`onEnd` 正文/CoT；`onFinish` 只取 `usage`。`sources`、`webSearchCount`/`webFetchCount`（计费次数）、`webToolsCostMicros`；`costMicros = token + web`。
- `session` 未创建时用可选链，不解引用。`persisted = true` 在 DB 事务成功之后、Redis `recordSpend` 之前，失败可再试且不因 Redis 失败重复插消息。
- abort/未走到 `onEnd`：已有计费 web 或已有文本时同样落库（usage 可为 0，`finishReason` 回退 `aborted`）。
- 开流前周预算硬 429 保留；开流后工具费用不再硬 429。

## TDD

1. 先改 mock，再改实现。
   - `vi.mock('ai')` 补 `isStepCount` / `tool` / `jsonSchema`
   - `vi.mock('./llm/create-web-tools.js')`
   - billing mock 补 `computeWebToolsCostMicros`、`getWebToolPrices`
   - 去掉 `create-language-model` mock，改为 `ChatModelFactory` `{ create: createLanguageModelMock }` + `DeepSeekToolsClient` useValue
2. 删除旧用例 `buildModelMessages does not put historical reasoning into model messages`（`not.toContain(secretCot)`），改成限额内包含、超轮次/超字数不包含全文、空 CoT 不捏造。
3. **实现前** `npx vitest run src/chat/chat-stream.service.spec.ts`：

   ```
   Test Files  1 failed (1)
   Tests  11 failed | 12 passed (23)
   ```

   红的包括：`stopWhen`/tools 未传入、历史 CoT 未进 messages、`computeWebToolsCostMicros` 未被调用、无 `onEnd` 时 `recordSpend` 为 0、DB 失败后因先置 `persisted` 导致重试 `recordSpend` 仍为 0、`createWebTools` 抛错时期望拒绝但 promise resolved。12 条旧路径（含空 CoT 不捏造、开流前 429）保持绿。

4. 实现后同一文件 2 条失败，是断言写法：`JSON.stringify` 遇到 `bigint`；重试会计入失败的那次 `message.create`。改正断言后转绿，不是改实现放水。
5. Provider 层：`deepseek-provider.replay.spec.ts` 新增「无 reasoning 的 assistant + 最小 tool」。`deepseek-flash`（SDK 视为 V4）请求体 `reasoning_content === ""`。未在 mock 掉 `ai` 的 stream spec 里做 payload 断言。

## Tests

| Command                                                                                             | Result                   |
| --------------------------------------------------------------------------------------------------- | ------------------------ |
| `npx vitest run src/chat/chat-stream.service.spec.ts src/chat/llm/deepseek-provider.replay.spec.ts` | 2 files, **25 passed**   |
| `npx vitest run src/chat`                                                                           | 18 files, **101 passed** |
| `npm run lint`                                                                                      | OK                       |
| `npm run typecheck`                                                                                 | OK                       |
| `npm run format:check`                                                                              | OK                       |

## Commit

`c135ed0 feat(chat): 流式对话接入 Search/Fetch 工具与来源落库`

## Concerns

- `npm run typecheck:all` 仍失败，全在既有 `src/chat/llm/create-web-tools.spec.ts`（`Tool.execute` 参数类型）。本次改动的文件无报错。`tsconfig.build.json` 的 `typecheck` 通过。
- 流式 `maxOutputTokens` 改为每步 `CHAT_WEB_STEP_MAX_TOKENS`，不再使用 `CHAT_MAX_TOKENS`（4096）。
- 无来源时 `sources` 写 `Prisma.JsonNull`。
- 空 `reasoning_content` 由 `@ai-sdk/deepseek@3.0.63` 对 V4（含 `deepseek-flash`）回填 `''`。旧 id `deepseek-chat` / `deepseek-reasoner` 不会填该字段。本仓库模型是 `deepseek-flash`。真网不 400 仍是 Task 9。
- Redis `recordSpend` 失败不会把 `persisted` 打回 false，避免重复插同一条助手消息；周账本已在同一 DB 事务里。

## Fix: abort / onEnd 落库竞态

- 单飞：`onEnd` 一开始就占住快照并启动唯一的 `persistFlight`。`finally` 只在 `onEnd` 没开始时落库；若 `onEnd` 已开始或已有 in-flight，则等待同一次写入。
- 写入前让出一个微任务，这样同一轮里后到的 `onEnd` 可以改掉 `finally` 刚读到的空 `pending`。库里的正文是 `onEnd` 文本。
- 助手消息 id 的 Prisma P2002：`persisted = true`，不再 `recordSpend`。`userId` / `period` 上的 P2002 仍抛出，允许重试。
- `isCancelled` 与 `isAborted` 一样，`finishReason` 记为 `aborted`。

### Tests

`npx vitest run src/chat/chat-stream.service.spec.ts`

```
Test Files  1 passed (1)
Tests  25 passed (25)
Duration  2.38s
```

新增：延迟 insert 时 `onEnd` 与 `finally` 重叠，只插入一行且 content 为 `onEnd` 正文；该消息 id 的 P2002 不二次 `recordSpend`。
