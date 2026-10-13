# Bot 一等实体与 1:1 会话 — Design Spec

**日期：** 2026-10-13  
**分支：** `feature/bots`  
**状态：** 待实现（brainstorming 已对齐）

## 背景与目标

前端产品以 **Bot** 为中心（主 Bot、子 Bot、创建页、首页列表展示最近一条回复）。当前后端仅有 `Conversation / Message / Attachment / ChatWeeklySpend`，会话文档无 `botId`，无法对接首页与创建 Bot。

本轮目标：

1. Bot 成为一等实体（CRUD + 外观 + 可选人设）
2. Bot 与 Conversation **严格 1:1**
3. 注册自动建主 Bot；子 Bot 软删级联会话软删
4. 流式对话注入该 Bot 的 `systemPrompt`（可空）
5. **不做**主 Bot 感知子 Bot 聊天记录（下轮再做）

前端可先对接、且本轮基本不变的接口：Auth、`GET /chat/quota`、附件、消息历史、流式路径。首页列表与创建入口改为 `/bots`。

---

## 决策摘要

| 议题            | 选择                                                                     |
| --------------- | ------------------------------------------------------------------------ |
| Bot vs 会话     | Bot 一等实体；会话必须挂 Bot                                             |
| 基数            | 严格 1:1（创建 Bot = 同时建唯一会话）                                    |
| 主 Bot          | 注册时自动创建；每用户至多 1 个未删 `main`；不可删                       |
| 字段            | `name`、`faceColor`、`faceShape`、`kind`、可选 `systemPrompt`            |
| 删子 Bot        | 会话一并软删                                                             |
| 感知子 Bot 历史 | 本轮不做                                                                 |
| 会话创建入口    | 对外以 `POST /bots` 为准；不再用裸 `POST /chat/conversations` 作创建入口 |
| 实现路径        | `Bot` 表 + `Conversation.botId` UNIQUE                                   |

---

## 数据模型

### `Bot`

| 字段                      | 类型                                  | 说明                              |
| ------------------------- | ------------------------------------- | --------------------------------- |
| `id`                      | UUID                                  | PK                                |
| `userId`                  | UUID                                  | FK → User                         |
| `name`                    | string                                | 展示名；主 Bot 默认产品名「牛马」 |
| `kind`                    | enum `main` \| `sub`                  |                                   |
| `faceColor`               | string                                | 如 `#DB2777` / `#0A0A0A`          |
| `faceShape`               | enum `circle` \| `oval` \| `squircle` |                                   |
| `systemPrompt`            | string?                               | 空则流式用全局默认                |
| `deletedAt`               | DateTime?                             | 软删                              |
| `createdAt` / `updatedAt` | DateTime                              |                                   |

约束：

- `@@unique([userId, kind])` **不适用**（多个 `sub`）；改为应用层保证：每用户至多 1 条 `deletedAt IS NULL AND kind = main`
- 索引：`[userId, updatedAt]`、`[userId, kind]`

主 Bot 默认外观（与前端主 Bot 对齐）：`faceColor = #0A0A0A`，`faceShape = circle`。

### `Conversation` 变更

- 新增 `botId` UUID NOT NULL，FK → Bot，`onDelete: Restrict`（业务软删，不物理级联）
- `@@unique([botId])` 保证 1:1
- 现有字段 `title` / `deletedAt` 保留

### 列表预览（不落库）

`Bot` 列表/详情 DTO 运行时拼接：

- `conversationId`
- `lastMessagePreview`：该会话最近一条消息的可见文本截断（无则 `null`）
- `lastMessageAt`：该条 `createdAt`（无则 `null`）

---

## API 契约

统一 JSON 信封；需 `Authorization: Bearer`。创建类成功 HTTP **201**，信封 `code` 仍为 **200**。

### Bot

| Method | Path        | 说明                                                                       | 限流建议 |
| ------ | ----------- | -------------------------------------------------------------------------- | -------- |
| GET    | `/bots`     | 未删 Bot；`main` 在前，其余按 `updatedAt` 降序；含预览字段                 | 60/min   |
| POST   | `/bots`     | 创建 **sub** Bot + 唯一会话                                                | 20/min   |
| GET    | `/bots/:id` | 详情 + 预览                                                                | 60/min   |
| PATCH  | `/bots/:id` | 改 `name` / `faceColor` / `faceShape` / `systemPrompt`，或 `deleted: true` | 20/min   |

**POST `/bots` body**

```json
{
  "name": "日程助手",
  "faceColor": "#DB2777",
  "faceShape": "squircle",
  "systemPrompt": "可选，最长建议 4000"
}
```

校验：`name` 必填非空（建议 max 50）；`faceColor` 匹配 `#` + 6 位 hex；`faceShape` 枚举；禁止通过此接口创建 `main`。

**成功 data 示例**

```json
{
  "id": "uuid",
  "name": "日程助手",
  "kind": "sub",
  "faceColor": "#DB2777",
  "faceShape": "squircle",
  "systemPrompt": null,
  "conversationId": "uuid",
  "lastMessagePreview": null,
  "lastMessageAt": null,
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```

**PATCH**

```json
{
  "name": "新名字",
  "faceColor": "#2563EB",
  "faceShape": "oval",
  "systemPrompt": "你是日程助手",
  "deleted": true
}
```

- `deleted: true`：软删该 Bot，并将其唯一 Conversation 一并 `deletedAt = now()`
- 对 `kind=main` 软删 → **400**「主 Bot 不可删除」
- 不存在或不属于当前用户 → **404**

### 会话侧调整

| 接口                                           | 本轮行为                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /chat/conversations`                     | **直接移除对外创建路由**（文档写明改用 `POST /bots`）；避免双入口。不保留 410 兼容期 |
| `GET /chat/conversations`                      | 保留；DTO 增加 `botId`；可选 `?botId=`                                               |
| `GET/PATCH /chat/conversations/:id`            | 保留；DTO 增加 `botId`                                                               |
| `GET .../messages`、`POST .../messages/stream` | 路径与协议不变                                                                       |
| 附件                                           | 不变                                                                                 |

流式：解析会话 → 加载未删 Bot → 若 `systemPrompt` 非空则注入/覆盖 system；空则保持现有全局默认。不注入其他 Bot 历史。

---

## 注册与存量迁移

### 注册

`POST /auth/register` 成功路径同一事务：

1. 创建 User
2. 创建 main Bot（默认名与外观）
3. 创建 Conversation（`botId` 指向主 Bot）

### 懒补主 Bot

已存在用户若无未删 main Bot（历史数据或异常）：在首次需要主 Bot 的路径（如 `GET /bots`）事务内补建 main + Conversation，与注册同结构。

### 存量 Conversation 无 `botId`

Migrate 数据步骤：

1. 按 `userId` 分组
2. 无主 Bot → 建主 Bot
3. 该用户第一条未删会话挂主 Bot
4. 其余未删会话：各建 `sub` Bot（`name` = 原 `title`，默认脸），再挂上
5. 已软删会话：同样建对应 Bot（或 sub），挂上并保持会话 `deletedAt`

然后施加 `botId` NOT NULL + UNIQUE。

---

## 模块与代码落点（实现指引）

- 新模块或挂在 `chat` 下：`bots.controller.ts` / `bots.service.ts` / DTOs（跟现有 Nest 风格）
- Prisma：`Bot` model + `Conversation.botId` + enum
- Auth 注册 service：事务扩展
- `ChatStreamService`：加载 bot.systemPrompt
- 更新 `docs/chat-api-frontend.md`（或合并进该文档的 Bot 章节）
- 测试见下节

---

## 测试范围

| 层                  | 覆盖                                                                           |
| ------------------- | ------------------------------------------------------------------------------ |
| BotsController spec | list / create sub / get / patch / soft-delete sub；删 main → 400；401          |
| BotsService         | 创建 1:1 会话；软删级联会话                                                    |
| Auth                | 注册后存在 main + conversation；懒补主 Bot                                     |
| Stream              | 有 systemPrompt 时注入；无则行为与现网一致                                     |
| e2e                 | 注册 → GET /bots 有 main → POST /bots → 持 conversationId 走消息或 stream 冒烟 |
| 文档                | 前端对接文档同步                                                               |

每个对外 HTTP 接口必须有自动化测试（仓库 AGENTS 硬性要求）。

---

## 非目标（本轮不做）

- 主 Bot 感知/检索子 Bot 全量或摘要记忆
- Bot 头像 URL、bio、多会话线程
- 群聊 / 定时任务等前端筛选项后端化

---

## 前端对接提示（供联调，非本仓库必做）

- 首页列表：`GET /bots`（用 `lastMessagePreview`）
- 创建页：`POST /bots`
- 进聊天：用返回的 `conversationId` 调历史 + stream
- 用量：`GET /chat/quota`
- 停用：`POST /chat/conversations` 作为「新建 Bot」入口

---

## 开放细节（实现时可定默认，无需再开 brainstorm）

- `name` / `systemPrompt` 最大长度：建议 50 / 4000
- `lastMessagePreview` 截断长度：建议 80 字符
- 主 Bot 默认 `name`：与 `APP_NAME` / 配置一致（「牛马」）
- 对外关闭 `POST /chat/conversations`：优先删路由；若兼容期需要可临时 410 + 中文 message
