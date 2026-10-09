# AGENTS.md

给在本仓库工作的 AI / 自动化助手的约束。人类开发者同样建议遵守。

规范依据：[开发规范链](https://blog.qibmz.com/blog/dev-spec-chain) —— 本地快检、远程 CI、PR 审阅、合并上线分层门禁。

## 规范链总览

```text
本地：lint-staged + commitlint
  → push develop → CI（lint / typecheck / test / build + commitlint）
  → PR develop → main（填 Test plan，CI 再跑）
  → 合并 main → 生产
```

原则：本地只查暂存文件；CI 跑全量；**不要**在 pre-commit 跑全量 typecheck / test / build。

## 分支策略

| 分支      | 用途                                  |
| --------- | ------------------------------------- |
| `develop` | 日常开发、联调、测试环境              |
| `main`    | 生产发布，只通过 PR 从 `develop` 合并 |

流程：本地开发 → commit → push `develop` → 验证 → 开 PR：`develop` → `main` → CI 全绿 + 看过 diff → 合并。

## 提交规范（commitlint）

- 必须遵循 [Conventional Commits](https://www.conventionalcommits.org/)：`type(scope): subject`
- `subject` **必须使用中文**，说清动机；禁止整句英文 subject
- `type` 保持英文小写：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `build` / `ci` / `chore` / `revert`
- 由 Husky `commit-msg` + commitlint 校验；CI 对 push / PR 再验一遍
- 示例：
  - `feat(auth): 新增邮箱确认与找回密码`
  - `fix(auth): 无 JWT 时统一返回 401`
  - `test(auth): 补齐认证接口单元测试`
  - `chore: 接入 commitlint`
  - `ci: CI 支持 develop 并校验提交信息`

大改动请**分批提交**（功能 / 修复 / 测试 / 文档 / CI 分开），避免一把梭。

## 必须遵守

1. 提交信息使用约定式格式（见上）。
2. 改完代码确保能通过本仓库的 `lint` 与 `typecheck`；有单测的改动必须更新/补充测试。
3. 不要手改 Prisma Client 等生成物，走 `npx prisma generate` / migrate。
4. 环境变量、密钥、真实 DSN / API Key 不要写进仓库。
5. 合并到生产走 PR（`develop` → `main`），并在 Test plan 里说明如何验证。

## 改完后的自检

```bash
npm run lint && npm run typecheck && npm run test && npm run build
```

涉及 HTTP 契约时再跑：`npm run test:e2e`。

## 接口与测试（硬性）

- **每个对外 HTTP 接口都必须有自动化测试**，合入前保持绿灯
- 最低要求：
  - Controller / 路由层：`*.spec.ts`（可 mock Service）覆盖主成功路径与关键失败路径（401/400/409 等）
  - 复杂业务：保留或补充 Service 单测
  - 跨模块契约：有对应 e2e（`test/**/*.e2e-spec.ts`）覆盖统一响应结构等
- **新增或修改接口时，同一批改动必须带上/更新测试**；禁止只改实现不改测试

## PR 描述结构

```markdown
## Summary

- 改了什么、为什么

## Test plan

- [ ] CI 通过
- [ ] 测试 / 本地关键路径验证
- [ ] 合并后需确认的事项
```

## 代码与安全习惯

- 用户可见错误信息优先中文
- 认证失败（无 token / 解析失败 / 过期）必须是 **401**，不要变成 500
- 邮箱统一规范化后再查库；敏感接口注意限流与枚举防护

## 文档

- 对外行为变更时同步更新 `README.md` / Swagger 注释（中文）
- 本仓库约定优先于通用 Nest 文档；实现细节不确定时再查官方 LLM 文档，**不要**把全文拷进仓库或当 skill 安装
- 官方文档（按需拉取，无需导入）：
  - 目录：[https://docs.nestjs.com/llms.txt](https://docs.nestjs.com/llms.txt)
  - 全文：[https://docs.nestjs.com/llms-full.txt](https://docs.nestjs.com/llms-full.txt)
  - 单章 Markdown：文档路径加 `.md`（例如 [https://docs.nestjs.com/controllers.md](https://docs.nestjs.com/controllers.md)）
- Nest 官方没有 Cursor / Claude skill；社区 skill 默认不采用，以免覆盖本文件约束
