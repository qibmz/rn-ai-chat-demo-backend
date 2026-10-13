# Bot 一等实体与 1:1 会话 — Design Spec

**日期：** 2026-10-13  
**分支：** `feature/bots`  
**状态：** 待实现（brainstorming 已对齐；按 review 修订 P0/P1）

## 背景与目标

前端产品以 **Bot** 为中心（主 Bot、子 Bot、创建页、首页列表展示最近一条回复）。当前后端仅有 `Conversation / Message / Attachment / ChatWeeklySpend`，会话文档无 `botId`，无法对接首页与创建 Bot。

本轮目标：

1. Bot 成为一等实体（CRUD + 外观 + 可选人设）
2. Bot 与 Conversation **严格 1:1**
3. 注册自动建主 Bot；子 Bot 软删级联会话软删
4. 流式对话注入该 Bot 的 `systemPrompt`（可空）
5. **不做**主 Bot 感知子 Bot 聊天记录（下轮再做）

前端可先对接、且本轮基本不变的接口：Auth、`GET /chat/quota`、附件、消息历史、流式路径。首页列表与创建入口改为 `/bots`。

**发布约定：** 移除 `POST /chat/conversations` 为破坏性变更，须与前端同批发布（确认前端已改走 `POST /bots` 后再合入/部署）。旧客户端会收到统一信封下的 404，难以区分「路由没了」与「资源不存在」，故不留 410 兼容期、也不拖长双入口窗口。

---

## 决策摘要

| 议题            | 选择                                                                  |
| --------------- | --------------------------------------------------------------------- |
| Bot vs 会话     | Bot 一等实体；会话必须挂 Bot                                          |
| 基数            | 严格 1:1（创建 Bot = 同时建唯一会话）                                 |
| 主 Bot          | 注册时自动创建；每用户至多 1 个未删 `main`（DB 部分唯一索引）；不可删 |
| 字段            | `name`、`faceColor`、`faceShape`、`kind`、可选 `systemPrompt`         |
| 删子 Bot        | 会话一并软删                                                          |
| 感知子 Bot 历史 | 本轮不做                                                              |
| 会话创建入口    | 对外**删除** `POST /chat/conversations`；仅 `POST /bots`              |
| 实现路径        | `Bot` 表 + `Conversation.botId` UNIQUE                                |
| UI 展示名       | 以 `Bot.name` 为准；`Conversation.title` 本轮不作为 UI 主展示名       |

---

## 数据模型

### `Bot`

| 字段                      | 类型                                  | 说明                                                                                     |
| ------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `id`                      | UUID                                  | PK                                                                                       |
| `userId`                  | UUID                                  | FK → User                                                                                |
| `name`                    | string                                | 展示名；注册时快照写入 `ConfigService.get('APP_NAME')`（默认「牛马」），**不**每次读 env |
| `kind`                    | enum `main` \| `sub`                  |                                                                                          |
| `faceColor`               | string                                | 如 `#DB2777` / `#0A0A0A`                                                                 |
| `faceShape`               | enum `circle` \| `oval` \| `squircle` |                                                                                          |
| `systemPrompt`            | string?                               | 空则流式仅用全局默认（见「流式 system 优先级」）                                         |
| `deletedAt`               | DateTime?                             | 软删                                                                                     |
| `createdAt` / `updatedAt` | DateTime                              |                                                                                          |

约束与索引：

- Prisma 无法表达「仅未删 main」的条件唯一 → **migration 手写部分唯一索引**：

```sql
CREATE UNIQUE INDEX bots_user_main_undeleted_key
  ON bots (user_id)
  WHERE kind = 'main' AND deleted_at IS NULL;
```

- 懒补主 Bot：插入时捕获 Prisma `P2002`（或等价 `ON CONFLICT DO NOTHING` + 回读），保证幂等
- 普通索引：`[userId, updatedAt]`、`[userId, kind]`

主 Bot 默认外观（与前端主 Bot 对齐）：`faceColor = #0A0A0A`，`faceShape = circle`。

`faceColor` 校验正则：`/^#[0-9a-fA-F]{6}$/`（大小写均接受）。

`name` / `systemPrompt` 最大长度：50 / 4000。

`main` 的 `systemPrompt` **允许**被 `PATCH` 修改（与 sub 相同）；禁止的只有 `deleted: true`。

### `Conversation` 变更

- 新增 `botId` UUID，FK → Bot，`onDelete: Restrict`（业务软删，不物理级联）
- `@@unique([botId])` 保证 1:1
- 现有字段 `title` / `deletedAt` 保留

**`title` 定位（本轮）：**  
UI 展示名以 `Bot.name` 为准。`Conversation.title` 保留供迁移与兼容；`PATCH /chat/conversations/:id` 仍可改 `title`，但**前端首页/顶栏应展示并编辑 `Bot.name`**（`PATCH /bots/:id`）。文档须写明，避免双源展示。

### 列表预览（不落库，禁止 N+1）

`Bot` 列表/详情 DTO 运行时拼接：

- `conversationId`
- `lastMessagePreview`：截断建议 80 字符
- `lastMessageAt`

取数：对当前用户相关 `conversation_id` **一次查询**完成（PostgreSQL `DISTINCT ON (conversation_id)` 或窗口函数 `ROW_NUMBER()`），禁止按 Bot 循环查最近消息。

预览规则：

- 只考虑 `role IN (user, assistant)`，**排除** `system`
- **不**使用 `reasoningContent`
- 可见文本优先 `content` trim；若为空且 parts 含 image → 预览固定为 `[图片]`
- 无符合条件消息 → `lastMessagePreview` / `lastMessageAt` 均为 `null`

---

## API 契约

统一 JSON 信封；需 `Authorization: Bearer`。创建类成功 HTTP **201**，信封 `code` 仍为 **200**。

### Bot

| Method | Path        | 说明                                                                         | 限流建议 |
| ------ | ----------- | ---------------------------------------------------------------------------- | -------- |
| GET    | `/bots`     | 未删 Bot；`main` 在前，其余按 `updatedAt` 降序；含预览字段；必要时懒补主 Bot | 60/min   |
| POST   | `/bots`     | 创建 **sub** Bot + 唯一会话                                                  | 20/min   |
| GET    | `/bots/:id` | 详情 + 预览                                                                  | 60/min   |
| PATCH  | `/bots/:id` | 改 `name` / `faceColor` / `faceShape` / `systemPrompt`，或 `deleted: true`   | 20/min   |

**POST `/bots` body**

```json
{
  "name": "日程助手",
  "faceColor": "#DB2777",
  "faceShape": "squircle",
  "systemPrompt": "可选，最长 4000"
}
```

校验：`name` 必填非空 max 50；`faceColor` 满足 `/^#[0-9a-fA-F]{6}$/`；`faceShape` 枚举；禁止通过此接口创建 `main`。

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

| 接口                                           | 本轮行为                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /chat/conversations`                     | **删除对外创建路由**（同步删除/改写相关 controller 单测与限流用例）；前端同批切到 `POST /bots` |
| `GET /chat/conversations`                      | 保留；DTO 增加 `botId`；可选 `?botId=`                                                         |
| `GET/PATCH /chat/conversations/:id`            | 保留；DTO 增加 `botId`                                                                         |
| `GET .../messages`、`POST .../messages/stream` | 路径与协议不变                                                                                 |
| 附件                                           | 不变                                                                                           |

### 流式 system 优先级（必须定死）

现有实现会 prepend 全局 `CHAT_SYSTEM_PROMPT`，并仍会把历史 `role=system` 消息拼进上下文。

本轮规则：

1. **Bot `systemPrompt` 非空**：只使用 Bot 的 prompt 作为**唯一**前置 system 消息；**不**再 prepend 全局 `CHAT_SYSTEM_PROMPT`。
2. **Bot `systemPrompt` 为空**：行为与现网一致——若配置了全局 `CHAT_SYSTEM_PROMPT` 则 prepend 它。
3. **历史库内 `role=system` 消息**：本轮**继续**按现有逻辑拼进上下文（不额外清理）。跨 Bot 人设污染风险已知，清理属后续清理项，不在本轮范围。
4. 不注入其他 Bot 的聊天记录或摘要。

---

## 注册与存量迁移

### 注册

`POST /auth/register` 成功路径同一事务：

1. 创建 User
2. 创建 main Bot：`name` = 当时 `APP_NAME` 快照，默认外观
3. 创建 Conversation（`botId` 指向主 Bot，`title` 可与 Bot 名相同）

### 懒补主 Bot

已存在用户若无未删 main Bot：在 `GET /bots`（及任何明确依赖主 Bot 的写路径）事务内补建。插入依赖部分唯一索引 + `P2002` 回读，保证并发下仍只有一个未删 main。

### 存量 `Conversation` 加 `botId`（分阶段，禁止一步 NOT NULL）

Migration / 数据脚本必须按序：

1. `ADD COLUMN bot_id UUID`（**可空**，无 FK/UNIQUE 或先不加 NOT NULL）
2. Data migration（按 `userId` 分组）：
   - 无主 Bot → 建主 Bot（未删）
   - 该用户**第一条未删**会话 → 挂主 Bot
   - 其余**未删**会话 → 各建未删 `sub` Bot（`name` = 原 `title`；大量默认「新对话」同名 **可接受**），再挂上
   - **已软删**会话 → 各建 `sub` Bot，且 Bot 的 `deletedAt` **同步非空**（与会话一致），再挂上；避免 `GET /bots` 冒出一批幽灵 Bot
3. **断言** `conversations.bot_id IS NULL` 行数为 0（失败则迁移中止）
4. `ALTER COLUMN bot_id SET NOT NULL`
5. 加 `UNIQUE(bot_id)` 与 FK → `bots(id)`
6. 创建部分唯一索引 `bots_user_main_undeleted_key`

---

## 模块与代码落点（实现指引）

- `src/chat/` 下新增：`bots.controller.ts` / `bots.service.ts` / DTOs（跟现有 Nest 风格）；或独立 `bots` 模块再由 AppModule 引入——实现时选与仓库一致的挂载方式
- Prisma：`Bot` / enums + `Conversation.botId`；migration 含 raw SQL 部分唯一索引与分阶段 NOT NULL
- Auth 注册 service：事务扩展
- `ChatStreamService`：按上文「流式 system 优先级」改组装
- 删除 `POST /chat/conversations` 路由，并清理 `chat-conversations.controller.spec.ts` 中对应用例
- 更新 `docs/chat-api-frontend.md`：增加 `/bots` 章节；标明创建入口变更与同批发布

---

## 测试范围

| 层                | 文件/位置（约定）                          | 覆盖                                                                                          |
| ----------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| BotsController    | `bots.controller.spec.ts`                  | list / create sub / get / patch / soft-delete sub；删 main → 400；401                         |
| BotsService       | `bots.service.spec.ts`（若逻辑在 service） | 创建 1:1；软删级联会话；懒补 main 并发幂等（可 mock 唯一冲突）                                |
| Auth              | 现有 auth 注册相关 spec / e2e              | 注册后存在 main + conversation                                                                |
| Stream            | `chat-stream.service.spec.ts`              | Bot prompt 非空时不发全局、只发 Bot；为空时与现网一致（有全局则 prepend）                     |
| Conversations     | `chat-conversations.controller.spec.ts`    | **删除**原 `POST` 成功/限流用例；保留 list/get/patch/messages/stream                          |
| e2e（必做）       | `test/*.e2e-spec.ts`                       | 注册 → `GET /bots` 有 main → `POST /bots` → `GET .../messages` 空列表；**不**要求真调上游 LLM |
| e2e（非本轮必做） | —                                          | 真 stream 冒烟需假上游 + `LLM_BASE_URL`；标注为后续，除非另开任务补假上游                     |
| 文档              | `docs/chat-api-frontend.md`                | 同步                                                                                          |

每个对外 HTTP 接口必须有自动化测试（仓库 AGENTS 硬性要求）。

---

## 非目标（本轮不做）

- 主 Bot 感知/检索子 Bot 全量或摘要记忆
- Bot 头像 URL、bio、多会话线程
- 群聊 / 定时任务等前端筛选项后端化
- 清理历史 `role=system` 消息拼进上下文的行为
- 真 LLM 上游的 e2e stream 冒烟（无假上游则不做）

---

## 前端对接提示（供联调，非本仓库必做）

- 首页列表：`GET /bots`（用 `lastMessagePreview` / `lastMessageAt`）
- 创建页：`POST /bots`
- 进聊天：用返回的 `conversationId` 调历史 + stream
- 改展示名/外观/人设：`PATCH /bots/:id`（不要用会话 title 当主展示名）
- 用量：`GET /chat/quota`
- **不要再调用** `POST /chat/conversations`（路由将删除；与后端同批发布）

---

## 开放细节（已定默认）

| 项                           | 默认                                 |
| ---------------------------- | ------------------------------------ |
| `name` / `systemPrompt` 长度 | 50 / 4000                            |
| `lastMessagePreview` 截断    | 80 字符                              |
| 主 Bot 名                    | 注册时 `APP_NAME` 快照落库           |
| `faceColor`                  | `/^#[0-9a-fA-F]{6}$/`                |
| 关闭创建会话                 | 直接删路由，不留 410；与前端同批发布 |
