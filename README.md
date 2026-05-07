# Codex Vercel Proxy

Codex Vercel Proxy 是一个部署在 Vercel Functions 上的 Codex 代理服务。它提供 OpenAI 兼容的 `/v1/models`、`/v1/responses`、`/v1/chat/completions` 接口，并使用 Postgres 管理多账号凭证、凭证轮换、失败冷却和定时刷新。

项目同时提供一个单文件 Web 控制面板，用于导入、查看、启用、禁用、刷新和删除凭证，并展示请求用量、模型排行、凭据维度、访问方维度和请求明细。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAETSIRAX%2Fcodex-vercel-proxy&project-name=codex-vercel-proxy&repository-name=codex-vercel-proxy&env=DATABASE_URL,PROXY_API_KEY,ADMIN_TOKEN,CRON_SECRET,CRED_ENCRYPTION_KEY&envDescription=请填写%20Postgres%20连接串和服务密钥。CODEX_BASE_URL、MODELS、USER_AGENT%20等变量可在部署后按需配置。)

## 控制面板预览

![Codex Proxy 控制面板](docs/assets/dashboard.png)

## 功能特性

- OpenAI 兼容接口：`/v1/models`、`/v1/responses`、`/v1/chat/completions`
- 凭证池管理：支持多条 Codex 凭证导入、状态查看、启用、禁用、刷新和删除
- 自动轮换：上游返回 `401`、`403`、`429` 或 `5xx` 时自动尝试下一条可用凭证
- Token 刷新：支持到期前懒刷新和 Vercel Cron 定时刷新
- 请求规范化：对齐 Codex 上游预期参数，并兼容常见 OpenAI 客户端调用方式
- 缓存路由：保留 `prompt_cache_key`，缺省时自动为 Codex 请求生成稳定缓存键
- 用量统计：记录请求耗时、模型、凭证、缓存 token、思考 token 和汇总数据
- 用量分析：控制面板支持按 24 小时、7 天、30 天查看请求走势和聚合排行
- 加密存储：凭证私密字段使用 `CRED_ENCRYPTION_KEY` 加密后写入 Postgres
- 控制面板：访问 `/` 或 `/dashboard`，手动输入 `ADMIN_TOKEN` 后管理凭证
- 健康检查：公开 `/healthz` 端点，检查关键环境变量和数据库连通性
- 单文件前端：控制面板位于 `public/index.html`，无需额外前端构建链路

## 架构

```text
Client / SDK
  |
  |  /v1/models
  |  /v1/responses
  |  /v1/chat/completions
  v
Vercel Rewrite
  |
  v
api/index.ts
  |
  v
src/index.ts
  |
  +-- src/auth.ts                 鉴权
  +-- src/chat.ts                 Chat Completions 转 Responses
  +-- src/codex.ts                上游请求、SSE、凭证轮换
  +-- src/credential-manager.ts   Postgres 凭证状态管理
  +-- src/usage.ts                请求用量明细和小时聚合
  +-- src/db.ts                   Postgres 共享连接
  +-- src/crypto.ts               凭证加密和解密
  |
  v
Codex upstream / Postgres
```

## 部署

在 Vercel 部署流程中，`DATABASE_URL` 可以手动填写，也可以通过 Vercel Marketplace Database Providers 创建。选择 Neon Serverless Postgres，创建数据库后，将连接串作为 `DATABASE_URL` 绑定到项目即可。

如果使用 Neon，建议填写 pooled connection string，通常 host 会包含 `-pooler`。服务在单个 Vercel Function 实例内最多保留 16 条数据库连接，用于减少凭据选择、用量统计和配额快照写入之间的排队。

部署时需要填写以下环境变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | Postgres 连接串，托管 Postgres 推荐启用 SSL |
| `PROXY_API_KEY` | 是 | `/v1/*` 代理接口访问密钥；多个 key 用英文逗号或换行分隔 |
| `ADMIN_TOKEN` | 是 | `/admin/*` 和控制面板访问密钥 |
| `CRON_SECRET` | 是 | `/cron/refresh` 和 `/cron/cleanup` 定时任务接口密钥 |
| `CRED_ENCRYPTION_KEY` | 是 | 凭证加密密钥，建议使用长随机字符串 |
| `CODEX_BASE_URL` | 否 | Codex 上游地址，默认 `https://chatgpt.com/backend-api/codex` |
| `MODELS` | 否 | `/v1/models` 返回的模型列表，逗号分隔，默认 `gpt-5.5,gpt-5.4` |
| `USER_AGENT` | 否 | 请求上游 Codex 时使用的 User-Agent |
| `RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS` | 否 | 成功请求后同一凭证配额快照最小刷新间隔，默认 `60`；usage limit 失败会强制刷新 |
| `REFRESH_LEAD_SECONDS` | 否 | token 到期前多少秒触发刷新，默认 `2 * 24 * 60 * 60` |
| `REFRESH_MIN_INTERVAL_SECONDS` | 否 | 强制刷新最小间隔，默认 `300` |
| `FAILURE_COOLDOWN_SECONDS` | 否 | 凭证失败后的通用冷却时间，默认 `300`；usage limit 命中时优先使用上游配额重置时间 |
| `REFRESH_LOCK_SECONDS` | 否 | 单条凭证刷新锁时间，默认 `120` |

### 手动部署

```bash
npm install
npm run typecheck
npx vercel login
npx vercel link
```

添加生产环境变量：

```bash
npx vercel env add DATABASE_URL production
npx vercel env add PROXY_API_KEY production
npx vercel env add ADMIN_TOKEN production
npx vercel env add CRON_SECRET production
npx vercel env add CRED_ENCRYPTION_KEY production
npx vercel env add CODEX_BASE_URL production
npx vercel env add MODELS production
npx vercel env add USER_AGENT production
npx vercel env add RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS production
npx vercel env add REFRESH_LEAD_SECONDS production
npx vercel env add REFRESH_MIN_INTERVAL_SECONDS production
npx vercel env add FAILURE_COOLDOWN_SECONDS production
npx vercel env add REFRESH_LOCK_SECONDS production
```

构建并发布：

```bash
npx vercel build --prod --yes
npx vercel deploy --prod --prebuilt
```

## 本地开发

```bash
npm install
cp .env.example .env.local
```

编辑 `.env.local`：

```ini
DATABASE_URL=postgres://user:password@host/dbname?sslmode=require
PROXY_API_KEY=replace-with-local-proxy-key
ADMIN_TOKEN=replace-with-local-admin-token
CRON_SECRET=replace-with-local-cron-secret
CRED_ENCRYPTION_KEY=replace-with-a-long-random-secret
CODEX_BASE_URL=https://chatgpt.com/backend-api/codex
MODELS=gpt-5.4,gpt-5.5
USER_AGENT="codex-tui/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9 (codex-tui; 0.118.0)"
RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS=60
REFRESH_LEAD_SECONDS=172800
REFRESH_MIN_INTERVAL_SECONDS=300
FAILURE_COOLDOWN_SECONDS=300
REFRESH_LOCK_SECONDS=120
```

启动本地服务：

```bash
npm run local
```

控制面板：

```text
http://localhost:3000/
```

类型检查：

```bash
npm run typecheck
```

## 使用方式

部署完成后，服务地址通常为：

```text
https://your-project.vercel.app
```

打开控制面板：

```text
https://your-project.vercel.app/
```

在控制面板中输入服务地址和 `ADMIN_TOKEN`。连接成功后，可以导入 Codex 凭证 JSON 并查看凭证状态。

健康检查：

```bash
curl -i "https://<vercel-domain>/healthz"
```

查询模型：

```bash
curl "https://<vercel-domain>/v1/models" \
  -H "Authorization: Bearer <PROXY_API_KEY>"
```

代理、管理和定时任务接口都支持用 `x-api-key: <token>` 替代 `Authorization: Bearer <token>`。

Chat Completions：

```bash
curl "https://<vercel-domain>/v1/chat/completions" \
  -H "Authorization: Bearer <PROXY_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [
      {"role": "user", "content": "请只回复一句简短中文。"}
    ]
  }'
```

Responses：

```bash
curl "https://<vercel-domain>/v1/responses" \
  -H "Authorization: Bearer <PROXY_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "input": "请只回复一句简短中文。"
  }'
```

导入单条凭证：

```bash
curl -X POST "https://<vercel-domain>/admin/credentials/import" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  --data-binary @/path/to/codex-token.json
```

## 凭证格式

只支持以下根对象扁平字段的 token JSON 文件：

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "id_token": "...",
  "account_id": "...",
  "disabled": false,
  "email": "user@example.com",
  "expired": "2026-05-06T12:00:00Z",
  "last_refresh": "2026-05-06T11:00:00Z",
  "type": "..."
}
```

管理接口只返回凭证状态，不返回 token 明文。

## Token 刷新

OpenAI 的 `refresh_token` 是一次性 token。刷新成功后，服务会把新的 `access_token`、`refresh_token`、`id_token`、账号身份、过期时间和最后刷新时间一起写回 Postgres。

如果凭证已经出现 `refresh_token_reused` 或其他 refresh token 失效错误，服务会自动停用这条凭证。代码无法原地修复，需要重新登录，导出新的凭证 JSON，再重新导入。

如果上游返回 `HTTP 429: The usage limit has been reached`，服务会读取上游配额快照中的 `reset_at`，把这条凭证冷却到对应窗口重置时间。缺少重置时间时，才退回 `Retry-After` 或 `FAILURE_COOLDOWN_SECONDS`。

## Prompt Caching

服务会保留客户端显式传入的 `prompt_cache_key`。如果请求没有传入该字段，会按调用方的代理密钥生成稳定 UUID，并把同一个值同时作为请求体 `prompt_cache_key` 和上游 `Session_id` 发送。

配置多个 `PROXY_API_KEY` 时，每个 key 会得到独立的缓存身份和用量统计。数据库只保存 key 的 SHA-256，控制面板按当前环境变量中的 key 顺序展示脱敏后的访问 KEY 用量。

实际是否命中缓存取决于上游服务和请求前缀是否完全一致。命中情况可通过上游 usage 中的 `input_tokens_details.cached_tokens` 等字段观察。

## 数据库

服务首次访问相关逻辑时会自动创建数据库表和索引：

- `credentials`：保存加密后的凭证正文、启用状态、错误信息、刷新锁、配额快照、成功和失败计数
- `usage_events`：保存最近请求明细，用于请求表格、错误率、平均耗时和 p95 分析
- `usage_hourly`：保存小时聚合，用于请求走势、token 汇总、模型排行、凭据维度和访问 KEY 用量

`credentials.encrypted_json` 字段保存加密后的凭证正文，加密密钥来自 `CRED_ENCRYPTION_KEY`。成功请求完成后，服务会按 `RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS` 节流，用实际使用的账号查询 Codex `/wham/usage`，把当前配额窗口、剩余百分比所需的 `used_percent`、重置时间和 credits 信息写入 `credentials.rate_limits_json`；usage limit 失败路径会跳过节流并立即刷新。

`CRED_ENCRYPTION_KEY` 用于解密已有凭证，生产环境变更该值后，旧凭证将无法解密。

## 定时任务

`vercel.json` 已配置两个 Vercel Cron：

```json
[
  {
    "path": "/cron/refresh",
    "schedule": "0 0 * * *"
  },
  {
    "path": "/cron/cleanup",
    "schedule": "0 3 * * *"
  }
]
```

`/cron/refresh` 刷新已到期或接近到期的启用凭证。`/cron/cleanup` 清理 90 天以前的 `usage_events` 明细，控制存储成本和查询规模。小时聚合表会长期保留。

## 项目文档

- [开发文档](docs/DEVELOPMENT_CN.md)
- [接口文档](docs/API_CN.md)

## 目录结构

```text
api/index.ts                 Vercel Function 入口
public/index.html            前端控制面板
src/index.ts                 路由、CORS、接口分发
src/auth.ts                  鉴权
src/codex.ts                 Responses 代理、上游请求、凭证轮换
src/chat.ts                  Chat Completions 转 Responses
src/credential-manager.ts    Postgres 凭证存储、刷新、状态维护
src/db.ts                    Postgres 共享连接
src/usage.ts                 请求用量明细和小时聚合
src/crypto.ts                凭证加密和解密
src/sse.ts                   SSE 编码、解析、读取
src/types.ts                 共享类型
src/utils.ts                 JSON、错误、时间、字符串工具
vercel.json                  Vercel Functions、Cron、rewrite 配置
```

## 安全

- 不要将 `.env.local`、`.dev.vars`、数据库连接串、服务密钥或凭证 JSON 提交到公开仓库。
- `PROXY_API_KEY` 和 `ADMIN_TOKEN` 应使用不同的随机值；需要多个代理 key 时，用英文逗号或换行分隔。
- `CRED_ENCRYPTION_KEY` 应长期稳定保存；更换后需要重新导入凭证。
- 控制面板只在当前页面内存中保存 `ADMIN_TOKEN`，不会写入浏览器本地存储。

## 许可证

本项目使用 GNU General Public License v3.0 许可证。完整许可证文本见 [LICENSE](LICENSE)。
