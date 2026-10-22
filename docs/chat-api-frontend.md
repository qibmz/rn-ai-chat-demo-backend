# Chat / AI 接口对接文档（前端）

> Base URL：开发环境示例 `http://192.168.x.x:3000`（或你的域名）  
> 鉴权：除特别说明外，**全部需要** `Authorization: Bearer <accessToken>`  
> 非流式接口统一响应信封如下；**流式接口不走信封**。

## 统一响应（JSON）

成功：

```json
{
  "code": 200,
  "message": "OK",
  "data": {},
  "timestamp": "2026-10-13T00:00:00.000Z",
  "path": "/chat/quota"
}
```

失败：

```json
{
  "code": 401,
  "message": "请先登录，或登录状态已失效",
  "errors": null,
  "timestamp": "...",
  "path": "/chat/quota"
}
```

常见状态：`400` 参数错误、`401` 未登录、`404` 资源不存在、`429` 限流/额度不足、`503` 附件存储未启用。

创建响应：`POST` 创建类接口成功时 HTTP 常为 `201`，信封内 `code` 仍为 `200`（与现有 Auth 一致）。

---

## 推荐对接顺序

1. `POST /auth/login`（或 register）拿 `accessToken`（注册成功后会自动创建**主 Bot**及其唯一会话）
2. `GET /chat/quota` 展示本周额度
3. `GET /bots` 首页 Bot 列表（含最近消息预览；必要时服务端懒补主 Bot）
4. 进入聊天：用列表项里的 `conversationId`，或 `POST /bots` 创建子 Bot（同时得到 `conversationId`）
5. （可选）`POST /chat/attachments` 上传图片 → 得到 `attachmentId`
6. `POST /chat/conversations/:id/messages/stream` 流式对话（`useChat`）
7. `GET /chat/conversations/:id/messages` 拉历史

**展示名：** 首页、顶栏、Bot 卡片请用 **`Bot.name`**（`PATCH /bots/:id` 改名）。`Conversation.title` 仍可在 `PATCH /chat/conversations/:id` 修改，但**不要**作为 UI 主展示源，避免与 Bot 名双源不一致。

**发布注意：** 已移除 `POST /chat/conversations` 创建会话。须与前端**同批**发布；旧客户端调该路由会得到 **404**（信封与「资源不存在」难以区分），不要拖长双入口窗口。

---

## 接口列表

| Method | Path                                      | 说明                                       | 限流约     |
| ------ | ----------------------------------------- | ------------------------------------------ | ---------- |
| GET    | `/chat/quota`                             | 本周额度百分比                             | 60/min     |
| GET    | `/bots`                                   | Bot 列表（含预览）                         | 60/min     |
| POST   | `/bots`                                   | 创建子 Bot + 唯一会话                      | 20/min     |
| GET    | `/bots/:id`                               | Bot 详情 + 预览                            | 60/min     |
| PATCH  | `/bots/:id`                               | 改外观/人设或软删子 Bot                    | 20/min     |
| GET    | `/chat/conversations`                     | 会话列表（DTO 含 `botId`；可选 `?botId=`） | 60/min     |
| GET    | `/chat/conversations/:id`                 | 会话详情（含 `botId`）                     | 60/min     |
| PATCH  | `/chat/conversations/:id`                 | 改标题 / 软删除                            | 20/min     |
| GET    | `/chat/conversations/:id/messages`        | 消息历史（分页）                           | 60/min     |
| POST   | `/chat/conversations/:id/messages/stream` | **流式发消息**                             | **10/min** |
| POST   | `/chat/attachments`                       | 上传图片                                   | **10/min** |
| GET    | `/chat/attachments/:id`                   | 附件临时 URL                               | 60/min     |

`:id` 均为 UUID。

---

## 1. 额度

`GET /chat/quota`

`data`：

| 字段               | 类型   | 说明                              |
| ------------------ | ------ | --------------------------------- |
| `usedPercent`      | number | 本周已用百分比（可 >100，软限制） |
| `remainingPercent` | number | 剩余百分比（下限 0）              |
| `usedRatio`        | number | 已用比例 0–1+                     |
| `period`           | string | 自然周标识（上海时区）            |
| `resetsAt`         | string | 下次重置 ISO 时间                 |
| `resetsInSeconds`  | number | 距重置秒数                        |

额度耗尽再开流会 **429**。

---

## 2. Bot

Bot 与 Conversation **严格 1:1**：创建子 Bot 会同时创建唯一会话；删子 Bot 会软删该会话。

### 字段（列表 / 详情 / 创建响应）

| 字段                      | 类型                             | 说明                                                              |
| ------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| `id`                      | string                           | Bot UUID                                                          |
| `name`                    | string                           | 展示名，最长 50                                                   |
| `kind`                    | `main` \| `sub`                  | 主 Bot 注册时自动创建，每用户至多一个未删 `main`                  |
| `faceColor`               | string                           | `#RRGGBB`（6 位十六进制）                                         |
| `faceShape`               | `circle` \| `oval` \| `squircle` | 头像形状                                                          |
| `systemPrompt`            | string \| null                   | 可选人设，最长 4000；见「流式 system」                            |
| `conversationId`          | string                           | 绑定的唯一会话 ID（发流式 / 拉历史用此 id）                       |
| `lastMessagePreview`      | string \| null                   | 最近一条 user/assistant 消息预览（最多约 80 字）；无消息为 `null` |
| `lastMessageAt`           | string \| null                   | 上述预览对应时间 ISO；无消息为 `null`                             |
| `createdAt` / `updatedAt` | string                           | ISO                                                               |

**预览规则（服务端拼接，不落库）：**

- 只统计 `role` 为 `user` 或 `assistant` 的消息，**不含** `system`
- **不使用** `reasoningContent`
- 文本优先 `content` trim；空文本且 parts 含图片 → 预览为 `[图片]`
- 无符合条件消息 → `lastMessagePreview` / `lastMessageAt` 均为 `null`

**列表排序：** `kind=main` 在前，其余按 `updatedAt` 降序；不含已软删 Bot。

**软删：** `PATCH /bots/:id` 传 `{ "deleted": true }` 软删**子 Bot**，并将其唯一 Conversation 一并软删。**主 Bot 不可删** → **400**「主 Bot 不可删除」。

### 列表

`GET /bots` → `data: BotDto[]`

已存在用户若缺少未删主 Bot，本接口会在事务内**懒补**主 Bot（及空会话），并发安全。

### 创建子 Bot

`POST /bots`

```json
{
  "name": "日程助手",
  "faceColor": "#DB2777",
  "faceShape": "squircle",
  "systemPrompt": "可选，最长 4000"
}
```

| 字段           | 必填 | 说明                             |
| -------------- | ---- | -------------------------------- |
| `name`         | 是   | 1–50 字符                        |
| `faceColor`    | 是   | 匹配 `/^#[0-9a-fA-F]{6}$/`       |
| `faceShape`    | 是   | `circle` \| `oval` \| `squircle` |
| `systemPrompt` | 否   | 最长 4000                        |

**不能**通过此接口创建 `main`。成功 `data` 为完整 `BotDto`（含 `conversationId`、预览字段）。HTTP **201**。

### 详情

`GET /bots/:id` → `data: BotDto`；不存在或不属于当前用户 → **404**。

### 更新

`PATCH /bots/:id`

```json
{
  "name": "新名字",
  "faceColor": "#2563EB",
  "faceShape": "oval",
  "systemPrompt": "你是日程助手",
  "deleted": true
}
```

字段均可选；主 Bot 的 `systemPrompt` 与 sub 一样可改，仅禁止 `deleted: true`。

---

## 3. 会话

对外**已无** `POST /chat/conversations`。会话随 Bot 创建（注册主 Bot / `POST /bots`）。

### ConversationDto 公共字段

除 `id`、`title`、`createdAt`、`updatedAt` 外，列表与详情均含：

| 字段    | 类型   | 说明            |
| ------- | ------ | --------------- |
| `botId` | string | 绑定的 Bot UUID |

### 列表 / 详情

- `GET /chat/conversations` → `data: ConversationDto[]`（按 `updatedAt` 降序，不含已软删）
- `GET /chat/conversations?botId=<uuid>` → 按 Bot 过滤（可选）
- `GET /chat/conversations/:id` → `data: ConversationDto`

### 更新 / 软删

`PATCH /chat/conversations/:id`

```json
{ "title": "新标题", "deleted": true }
```

`deleted: true` 软删除；之后列表/详情不可见。UI 展示名仍应以 **`Bot.name`** 为准。

---

## 4. 消息历史

`GET /chat/conversations/:id/messages?limit=50&before=<messageId>`

| Query    | 默认 | 说明                                         |
| -------- | ---- | -------------------------------------------- |
| `limit`  | 50   | 1–100                                        |
| `before` | —    | 游标：返回比该消息**更早**的消息（不含该条） |

`data`：

```json
{
  "items": [
    {
      "id": "uuid",
      "role": "user | assistant | system",
      "content": "可见文本",
      "parts": [
        { "type": "text", "text": "..." },
        {
          "type": "image",
          "attachmentId": "uuid",
          "mimeType": "image/jpeg",
          "byteSize": 12345,
          "url": "https://...presigned..."
        }
      ],
      "sources": null,
      "createdAt": "ISO"
    }
  ],
  "hasMore": false
}
```

注意：

- `items` 按时间升序（旧 → 新）。
- **当前不返回** `reasoningContent`（思考过程库内有，列表接口未暴露；流式时思考走 UI Message Stream 的 reasoning 部分）。
- 图片 `url` 为临时现签，过期后需重新拉列表或调附件接口。
- **`sources`**：`WebSource[] | null`。用户消息、以及本轮没有联网来源的助手消息为 `null`。有来源时为数组，字段见下表。**不返回** `webSearchCount`、`webFetchCount`、`webToolsCostMicros`、`costMicros`。
- 助手**正文**仍是 `content` / `parts` 里的 `text`，按 **Markdown** 渲染。`sources` 只是引用列表，不要把它当成正文。

`sources[]` 单项：

| 字段       | 类型           | 说明                                     |
| ---------- | -------------- | ---------------------------------------- |
| `title`    | string         | 标题                                     |
| `url`      | string         | 链接                                     |
| `snippet`  | string         | 摘要；搜索命中时有值，仅抓取时可能为空串 |
| `siteName` | string \| null | 可选，站点名                             |
| `fetched`  | boolean        | 可选；成功抓取后为 `true`                |

---

## 5. 流式对话（核心）

`POST /chat/conversations/:id/messages/stream`

- **Content-Type 请求**：`application/json`
- **响应**：`text/event-stream`（AI SDK **UI Message Stream**）
- **不要**按统一 JSON 信封解析；给 `@ai-sdk/react` 的 `useChat` + `DefaultChatTransport` 使用。

### 流式 system 优先级

会话通过 `botId` 关联 Bot。组装发给模型的 system 时：

1. **Bot `systemPrompt` 非空**：仅使用该 Bot 的 prompt 作为**唯一**前置 system 消息；**不再** prepend 全局环境变量 `CHAT_SYSTEM_PROMPT`。
2. **Bot `systemPrompt` 为空 / null**：与现网一致——若配置了全局 `CHAT_SYSTEM_PROMPT` 则 prepend 它。
3. 历史库内 `role=system` 的消息仍按现有逻辑拼进上下文（跨 Bot 污染风险已知，后续再清理）。

### 请求体

```json
{
  "messages": [
    {
      "id": "可选",
      "role": "user",
      "parts": [{ "type": "text", "text": "你好" }]
    }
  ],
  "thinking": true,
  "reasoningEffort": "high",
  "attachmentIds": ["uuid-可选"]
}
```

| 字段              | 必填 | 说明                                             |
| ----------------- | ---- | ------------------------------------------------ |
| `messages`        | 是   | AI SDK UIMessage 数组，至少 1 条                 |
| `thinking`        | 否   | 是否开启思考                                     |
| `reasoningEffort` | 否   | `low` \| `high` \| `max`（仅 thinking 时有意义） |
| `attachmentIds`   | 否   | 本轮用户消息关联的图片附件 ID                    |

### 流内关键事件（前端用 SDK 即可，一般不用手拆）

- 早期会有自定义 data：`data-chatMeta`，大致包含 `userMessageId`、`assistantMessageId`、`quota`
- 随后为 UI Message 文本 / reasoning 增量
- 联网时还会出现下面的过程 / 来源 data parts（`useChat` 消息 parts，类型即 `data-*`）
- 中途异常：可能收到 `data: {"type":"error","errorText":"..."}`（headers 已发出时）

请求体**没有**新的联网字段。模型自行决定是否调用搜索 / 抓取。

### 联网过程与来源（data parts）

这些 part 是过程态和引用，**不是**回答正文。正文仍是 text part，按 **Markdown** 渲染。

| type              | 何时出现                         | `data`                                             |
| ----------------- | -------------------------------- | -------------------------------------------------- |
| `data-webSearch`  | 搜索开始 / 结束 / 失败           | `{ status, query, errorText? }`                    |
| `data-webFetch`   | 抓取开始 / 结束 / 失败           | `{ status, url, title?, errorText? }`              |
| `data-webSources` | 成功搜索或成功抓取后**整表重写** | `{ sources: WebSource[] }`（字段同历史 `sources`） |

`status`：

- `data-webSearch`：`searching` → `done`，失败为 `error`（带中文 `errorText`）
- `data-webFetch`：`fetching` → `done`（`done` 带 `title`），失败为 `error`（带中文 `errorText`）

来源以**最新一条** `data-webSources` 为准（成功后会再发一版完整列表，不要把多次 part 拼接）。流结束后刷新历史，用消息上的 `sources`（无来源为 `null`）。没有 `data-webSources` 收尾包的保证，断线后以历史接口为准。

### RN / Expo 示例

```tsx
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { fetch as expoFetch } from 'expo/fetch';

const { messages, sendMessage, status } = useChat({
  transport: new DefaultChatTransport({
    api: `${API_BASE}/chat/conversations/${conversationId}/messages/stream`,
    fetch: expoFetch as typeof globalThis.fetch,
    headers: { Authorization: `Bearer ${accessToken}` },
  }),
});

// conversationId 来自 GET /bots 或 POST /bots 返回的 conversationId

// 纯文本
await sendMessage({ text: '你好' });

// 带附件：先 POST /chat/attachments，再在 body 侧带 attachmentIds
// （具体字段以你们 transport 自定义 prepareSendMessagesRequest 为准）
```

中断连接时服务端仍会尝试落盘助手消息（`finishReason=aborted`）。

---

## 6. 附件

### 上传

`POST /chat/attachments`  
`multipart/form-data`，字段名必须为 **`file`**

- 类型：JPEG / PNG / GIF / WebP
- 大小：默认上限约 8MB（`CHAT_MAX_IMAGE_BYTES`）

成功 `data`：

```json
{ "id": "uuid", "mimeType": "image/jpeg", "byteSize": 12345 }
```

`CHAT_ATTACHMENT_STORAGE=disabled` 时返回 **503**「附件存储未启用」。

### 临时链接

`GET /chat/attachments/:id`

```json
{
  "id": "uuid",
  "url": "https://...",
  "expiresAt": "ISO",
  "mimeType": "image/jpeg",
  "byteSize": 12345
}
```

---

## 错误与限流（前端提示建议）

| HTTP | 场景                 | 建议文案方向                     |
| ---- | -------------------- | -------------------------------- |
| 401  | Token 无效/过期      | 重新登录                         |
| 404  | 会话/附件/Bot 不存在 | 刷新列表                         |
| 400  | 删主 Bot 等          | 展示服务端 `message`             |
| 429  | 触发限流或周额度用尽 | 稍后再试 / 下周重置看 `resetsAt` |
| 503  | 附件存储关闭         | 隐藏上传入口或提示管理员开启 R2  |

流式接口限流更严：**约 10 次/分钟/用户**。

---

## 联调检查清单

- [ ] Bearer 带在所有 Chat / Bot 请求
- [ ] 首页用 `GET /bots`；新建子 Bot 用 `POST /bots`，**不要**再调 `POST /chat/conversations`
- [ ] 流式用 `DefaultChatTransport`，不要当普通 JSON POST
- [ ] `conversationId` 来自 Bot DTO；与 Bot 1:1
- [ ] UI 展示名用 `Bot.name`，编辑走 `PATCH /bots/:id`
- [ ] 图片：上传 → `attachmentIds` → stream；storage=disabled 时跳过上传
- [ ] 额度 UI：`usedPercent` + `resetsAt`
- [ ] 历史页：当前无思考字段，勿依赖 `reasoningContent`；引用来 `sources`（可能为 `null`）
- [ ] 流式过程态看 `data-webSearch` / `data-webFetch`；来源看最新 `data-webSources`，落库后看历史 `sources`
- [ ] 回答正文只渲染 text → Markdown，不要把 data parts 或 `sources` 当正文
- [ ] 后端与前端同批上线（移除旧创建会话接口）
