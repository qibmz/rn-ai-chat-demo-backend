# rn-ai-chat-demo-backend

RN AI Chat Demo 后端。代码基于 [nest-starter](https://github.com/qibmz/nest-starter) 初始化（不保留 starter 的 git 历史）。

NestJS 12：Prisma + PostgreSQL、Redis、BullMQ、JWT、Winston、Swagger、GitHub Actions CI；可选 Sentry Cloud 与 Resend 发信。

工具链对齐官方 TypeScript starter：**oxlint + Vitest**，纯 ESM（`"type": "module"`）。

## 分支与门禁

| 分支      | 用途                              |
| --------- | --------------------------------- |
| `develop` | 日常开发、联调、测试              |
| `main`    | 生产；仅通过 PR 从 `develop` 合并 |

本地：Husky `lint-staged` + `commitlint`（约定式提交，subject 中文）。  
远程：push / PR 到 `develop`、`main` 时跑 CI（format / lint / typecheck / test / build + commitlint）。  
详见 [AGENTS.md](./AGENTS.md) 与 [开发规范链](https://blog.qibmz.com/blog/dev-spec-chain)。

## Stack

| 层            | 技术                                                              |
| ------------- | ----------------------------------------------------------------- |
| Framework     | NestJS 12 · TypeScript 6 · ESM                                    |
| Data          | Prisma 6 · PostgreSQL                                             |
| Cache / queue | Redis · BullMQ                                                    |
| Auth          | JWT access + refresh（Passport，`@nestjs/jwt`），refresh 存 Redis |
| Email         | Resend（可选；未配置时入队并打日志）                              |
| Observability | Winston · Terminus `/health` · Sentry Cloud（可选）               |
| API           | Swagger · class-validator · 全局 `{ code: 200 }` 响应             |
| Quality       | oxlint · Vitest · Prettier · Husky · GitHub Actions               |

刻意不包含 Prometheus / Grafana / Loki 全家桶，需要时再加。

## Quick start

```bash
cp .env.example .env
docker compose up -d          # Postgres + Redis
npm install
npx prisma migrate deploy
npm run prisma:seed
npm run start:dev
```

|         | URL                            |
| ------- | ------------------------------ |
| API     | http://localhost:3000          |
| Swagger | http://localhost:3000/api-docs |
| Health  | http://localhost:3000/health   |

Seed 默认账号：`admin@example.com` / `password123`（可用 `SEED_EMAIL` / `SEED_PASSWORD` 覆盖）。

关闭 Swagger：`SWAGGER_ENABLED=false`。

## Environment

复制 `.env.example` 后按需填写。常用变量：

| 变量                                       | 说明                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `DATABASE_URL`                             | PostgreSQL 连接串                                                          |
| `REDIS_URL` / `REDIS_HOST` + `REDIS_PORT`  | Redis                                                                      |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | JWT 密钥（本地务必改掉）                                                   |
| `SEED_EMAIL` / `SEED_PASSWORD`             | `prisma:seed` 演示用户                                                     |
| `SENTRY_DSN`                               | 可选；空则禁用 Sentry                                                      |
| `SENTRY_TRACES_SAMPLE_RATE`                | 默认 `0.1`                                                                 |
| `RESEND_API_KEY`                           | 可选；空则邮件 job 只打日志                                                |
| `APP_NAME`                                 | 产品展示名（邮件 / Swagger / 日志），默认见 `.env.example`                 |
| `APP_URL`                                  | 邮件确认链接前缀，默认 `http://localhost:3000`                             |
| `EMAIL_VERIFY_EXPIRES_IN`                  | 确认 token 有效期，默认 `24h`                                              |
| `EMAIL_VERIFY_COOLDOWN`                    | 重发确认邮件冷却，默认 `60s`                                               |
| `EMAIL_VERIFICATION_REQUIRED`              | `true` 时未验证邮箱禁止登录（403），默认 `false`                           |
| `PASSWORD_RESET_EXPIRES_IN`                | 忘记密码验证码有效期，默认 `15m`（8 位数字码）                             |
| `PASSWORD_RESET_COOLDOWN`                  | 忘记密码发送冷却，默认 `60s`                                               |
| `CORS_ORIGINS`                             | 生产允许源（逗号分隔）；开发环境忽略并放行任意 Origin；生产未配则同源 only |
| `THROTTLE_TTL_MS` / `THROTTLE_LIMIT`       | 全局 HTTP 限流（Redis 共享，默认 60s / 100）                               |
| `MAIL_FROM`                                | 发件人；为空时回退为 `APP_NAME <onboarding@resend.dev>`                    |

### Sentry Cloud（可选）

1. 在 [sentry.io](https://sentry.io) 创建项目并复制 DSN
2. 设置 `SENTRY_DSN` 后重启

只上报 HTTP **5xx** / 未预期错误，避免 4xx 刷爆免费额度。

### Resend（可选）

1. 在 [resend.com](https://resend.com) 创建 API Key
2. 设置 `RESEND_API_KEY` 与 `MAIL_FROM`

未验证域名时可用 `onboarding@resend.dev`（通常只能发到你注册 Resend 的邮箱）。生产请验证自有域名，例如 `noreply@yourdomain.com`。

注册成功会入队邮箱确认邮件；有 key 时由 BullMQ worker 经 Resend 发出。

## Auth

| Method     | Path                        | Auth                                 |
| ---------- | --------------------------- | ------------------------------------ |
| POST       | `/auth/register`            | Public（发送邮箱确认链接）           |
| POST       | `/auth/login`               | Public                               |
| GET / POST | `/auth/verify-email`        | Public（query/body 带 `token`）      |
| POST       | `/auth/resend-verification` | Public（body 带 `email`）            |
| POST       | `/auth/forgot-password`     | Public（发送 8 位验证码）            |
| POST       | `/auth/reset-password`      | Public（email + code + newPassword） |
| POST       | `/auth/refresh`             | Public（body 带 refresh token）      |
| POST       | `/auth/logout`              | Public（body 带 refresh token）      |
| GET        | `/auth/me`                  | Bearer（含 `emailVerified`）         |

### Email verification

1. `POST /auth/register` 创建用户并入队确认邮件（token 存 Redis，默认 24h）。
2. 邮件链接：`{APP_URL}/auth/verify-email?token=...`（浏览器打开返回中文 HTML 结果页；API 也可 `POST` body `{ "token" }` 拿 JSON）。
3. 未收到：`POST /auth/resend-verification`。
4. 未验证仍可登录；`/auth/me` 返回 `emailVerified`，敏感操作可自行加 Guard。

### Forgot password

1. `POST /auth/forgot-password` `{ "email" }` — 发送 8 位验证码（Redis，默认 15m；仅实际发信后冷却 60s；不暴露邮箱是否存在）。
2. `POST /auth/reset-password` `{ "email", "code", "newPassword" }` — 校验码后更新密码并吊销该用户全部 refresh（错误超 5 次需重发）。

### Security notes

- 全局 Throttler（Redis 共享）；auth 敏感接口更严（如 login 10/min、forgot 5/min）；登录另有每账号失败计数。
- JWT 占位密钥会被 `validateEnv` 拒绝；反代环境请设 `TRUST_PROXY=1`。
- `EMAIL_VERIFICATION_REQUIRED=true` 时未验证邮箱登录返回 403。
- 邮箱入库/查询统一 `trim().toLowerCase()`。
- `resend-verification` 不暴露是否已验证；刷新令牌重用会吊销该用户全部会话。

## Response contract

Success:

```json
{
  "code": 200,
  "message": "OK",
  "data": {},
  "timestamp": "...",
  "path": "/auth/login"
}
```

Error:

```json
{
  "code": 400,
  "message": "参数校验失败",
  "errors": ["..."],
  "timestamp": "...",
  "path": "/auth/register"
}
```

`/health` 与 Swagger 不包一层统一响应。

## Scripts

| 命令                                          | 说明                             |
| --------------------------------------------- | -------------------------------- |
| `npm run start:dev`                           | 开发热重载                       |
| `npm run start:prod`                          | 生产（含 Sentry ESM `--import`） |
| `npm run build`                               | 编译                             |
| `npm run lint` / `format:check` / `typecheck` | 质量检查                         |
| `npm test` / `test:e2e`                       | 单测 / e2e                       |
| `npm run docker:up` / `docker:down`           | 起停 Postgres + Redis            |
| `npm run prisma:migrate`                      | 本地迁移开发                     |
| `npm run prisma:deploy`                       | 应用已有迁移                     |
| `npm run prisma:seed`                         | 幂等写入演示用户                 |

## License

MIT
