# 开发文档

本文说明项目结构、运行流程、环境变量和部署流程。

## 项目结构

```text
api/index.ts                 Vercel Function 入口
public/index.html            前端控制面板，手动输入 ADMIN_TOKEN 后调用管理接口
src/index.ts                 路由、CORS、接口分发
src/auth.ts                  Proxy/Admin/Cron 鉴权
src/codex.ts                 Responses 代理、上游请求、凭证轮换
src/chat.ts                  Chat Completions 到 Responses 的转换
src/credential-manager.ts    Postgres 凭证存储、刷新、状态维护
src/crypto.ts                凭证加密和解密
src/db.ts                    Postgres 共享连接
src/env.ts                   环境变量读取和默认值
src/sse.ts                   SSE 编码、解析、读取
src/types.ts                 共享类型
src/usage.ts                 请求用量明细、小时聚合和清理
src/utils.ts                 JSON、错误、时间、字符串工具
vercel.json                  Vercel Functions、Cron、rewrite 配置
```

## 请求流程

1. Vercel 将 `/v1/*`、`/admin/*`、`/cron/*` rewrite 到 `/api?__path=...`。
2. `api/index.ts` 调用 `handleRequest(request, loadEnv())`。
3. `src/index.ts` 根据路径分发：
   - `/healthz` 不需要鉴权，检查关键环境变量和数据库连通性
   - `/v1/*` 使用 `PROXY_API_KEY`
   - `/admin/*` 使用 `ADMIN_TOKEN`
   - `/cron/refresh` 使用 `CRON_SECRET`
   - `/cron/cleanup` 使用 `CRON_SECRET`
4. `/v1/responses` 进入 `proxyResponses()`。
5. `/v1/chat/completions` 先由 `chatToResponses()` 转成 Responses 请求，再复用 `proxyResponses` 的上游逻辑。
6. `fetchCodexWithRotation()` 从 Postgres 选择可用凭证，失败时按状态切换凭证。
7. 上游 Codex 总是使用 SSE 请求；下游非流式请求会在服务端聚合为 JSON。
8. 请求结束后，`src/usage.ts` 通过 `waitUntil` 异步写入 `usage_events` 明细和 `usage_hourly` 小时聚合，不阻塞代理响应。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | Postgres 连接串，需要支持 SSL |
| `PROXY_API_KEY` | 是 | `/v1/*` 接口访问密钥；多个 key 用英文逗号或换行分隔 |
| `ADMIN_TOKEN` | 是 | `/admin/*` 管理接口访问密钥 |
| `CRON_SECRET` | 是 | `/cron/refresh` 和 `/cron/cleanup` 定时任务密钥 |
| `CRED_ENCRYPTION_KEY` | 是 | 凭证加密密钥，建议使用长随机字符串 |
| `CODEX_BASE_URL` | 否 | Codex 上游地址，默认 `https://chatgpt.com/backend-api/codex` |
| `MODELS` | 否 | `/v1/models` 返回的模型列表，逗号分隔，默认 `gpt-5.5,gpt-5.4` |
| `USER_AGENT` | 否 | 请求上游 Codex 的 User-Agent |
| `RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS` | 否 | 成功请求后同一凭证配额快照最小刷新间隔，默认 `60`；usage limit 失败会强制刷新 |
| `REFRESH_LEAD_SECONDS` | 否 | token 到期前多少秒触发刷新，默认 `2 * 24 * 60 * 60` |
| `REFRESH_MIN_INTERVAL_SECONDS` | 否 | 强制刷新最小间隔，默认 `300` |
| `FAILURE_COOLDOWN_SECONDS` | 否 | 凭证失败后的通用冷却时间，默认 `300`；usage limit 命中时优先使用上游配额重置时间 |
| `REFRESH_LOCK_SECONDS` | 否 | 单条凭证刷新锁时间，默认 `120` |

示例：

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

## 数据库

服务启动后第一次访问相关逻辑时，会自动创建需要的表和索引。

数据库客户端使用全局 `postgres` 实例复用连接。单个 Vercel Function 实例内连接池上限为 16；如果使用 Neon，建议 `DATABASE_URL` 使用 pooled connection string，避免实例扩容时直接连接数增长过快。

`credentials` 保存凭证状态和加密后的凭证正文：

```sql
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  encrypted_json TEXT NOT NULL,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_used_at BIGINT,
  next_retry_at BIGINT,
  refresh_lock_until BIGINT,
  rate_limits_json JSONB,
  rate_limits_updated_at BIGINT,
  success_count BIGINT NOT NULL DEFAULT 0,
  failure_count BIGINT NOT NULL DEFAULT 0
);
```

`encrypted_json` 保存加密后的凭证正文。加密密钥来自 `CRED_ENCRYPTION_KEY`，生产环境不要更换该值；更换后旧凭证无法解密。

`rate_limits_json` 保存请求完成后从 Codex `/wham/usage` 读取到的配额快照。成功请求按 `RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS` 对同一凭证节流，usage limit 失败会立即刷新以获得最新重置时间。快照包含主 `codex` 限额和 additional rate limits 的 `usedPercent`、窗口长度、重置时间、plan type、credits 等字段。控制面板用 `100 - usedPercent` 展示剩余额度。

`usage_events` 保存逐请求明细：

```sql
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  completed_at BIGINT NOT NULL,
  duration_ms BIGINT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT,
  stream BOOLEAN NOT NULL,
  credential_id TEXT,
  client_hash TEXT,
  client_request_id TEXT,
  upstream_response_id TEXT,
  status_code INTEGER NOT NULL,
  error_code TEXT,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  cached_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0
);
```

`usage_hourly` 保存小时聚合，主键包含小时、接口、模型、凭据和访问方哈希：

```sql
CREATE TABLE IF NOT EXISTS usage_hourly (
  hour_start BIGINT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  client_hash TEXT NOT NULL,
  request_count BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  cached_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (hour_start, endpoint, model, credential_id, client_hash)
);
```

`/cron/cleanup` 会清理 90 天以前的 `usage_events` 明细。`usage_hourly` 长期保留，用于历史聚合分析。

访问方维度只保存代理 key 的 SHA-256。管理接口会用当前 `PROXY_API_KEY` 列表计算同样的哈希，并返回 `KEY 1 · <脱敏值>` 这样的 `clientKey` 展示名，控制面板据此显示每个代理 key 的 token 用量。

## 凭证格式

只支持根对象扁平 token JSON：

常用字段：

```json
{
  "access_token": "...",
  "account_id": "...",
  "disabled": false,
  "email": "user@example.com",
  "expired": "2026-05-06T12:00:00Z",
  "id_token": "...",
  "last_refresh": "2026-05-06T11:00:00Z",
  "refresh_token": "...",
  "type": "..."
}
```

说明：

- 服务按 `email`、`account_id` 或 `refresh_token` 生成稳定 ID。
- `disabled` 缺失时按 `false` 处理。
- 不支持 `metadata`、`token_data`、API key 凭证、单条凭证 `base_url` 或 `attributes.header:*`。
- 管理接口不会返回 token 明文。

## Token 刷新逻辑

OpenAI 的 `refresh_token` 是一次性的。刷新成功后，上游会返回新的 `refresh_token`，服务必须和新的 `access_token`、`id_token`、账号身份、过期时间一起持久化。否则下一次刷新会使用旧 token，触发 `refresh_token_reused`。

当前实现有两层保护：

- 同一 Vercel 实例内使用内存中的 `refreshInflight` 合并同一条凭证的刷新请求。
- 跨实例使用 `refresh_lock_until` 抢占数据库锁，并在锁内重新读取最新的 `encrypted_json`，避免拿旧密文继续消耗 refresh token。

如果刷新接口返回 `refresh_token_reused`，说明该 refresh token 已经被使用过。服务会自动停用这条凭证，代码无法恢复这类凭证，需要重新登录并导入新的凭证 JSON。

## 凭证选择和冷却

选择凭证时只会考虑：

- `disabled = false`
- `next_retry_at` 为空或已过期
- `refresh_lock_until` 为空或已过期

排序规则：

```text
COALESCE(last_used_at, 0) ASC, failure_count ASC, created_at ASC
```

上游返回以下状态时会尝试切换凭证：

```text
401, 403, 429, 5xx
```

单次请求最多尝试 8 条凭证。失败凭证会写入 `last_error`、增加 `failure_count`，并设置 `next_retry_at`。如果上游返回 `HTTP 429: The usage limit has been reached`，服务会读取上游配额快照中的未来 `reset_at`：已满窗口优先，多个窗口取更晚的重置时间；没有重置时间时，退回 `Retry-After` 或 `FAILURE_COOLDOWN_SECONDS`。

## Codex 请求规范化

Responses 入口会在转发前执行以下处理：

- `input` 为字符串时转成 user message
- 强制 `stream=true`
- 强制 `store=false`
- 强制 `parallel_tool_calls=true`
- 强制 `include=["reasoning.encrypted_content"]`
- 删除 `previous_response_id`、`prompt_cache_retention`、`safety_identifier`、`stream_options`
- 删除 `max_output_tokens`、`max_completion_tokens`、`max_tokens`、`temperature`、`top_p`
- 删除 `truncation`、`context_management`、`user`
- `service_tier` 只保留 `priority`
- `input[].role="system"` 改为 `developer`
- `web_search_preview` 和 `web_search_preview_2025_03_11` 改为 `web_search`
- `instructions` 缺失或为 `null` 时改为空字符串
- `prompt_cache_key` 显式传入时保留；缺省时按客户端代理密钥生成稳定 UUID，并把同一个值写入上游 `Session_id`

Chat Completions 入口会先转成 Responses：

- `system` message 转成 `developer` message
- `assistant` message 使用 `output_text`
- `user` message 使用 `input_text`
- `image_url` 转成 `input_image`
- `file` 转成 `input_file`
- `tool` message 转成 `function_call_output`
- `assistant.tool_calls` 转成顶层 `function_call`
- function tools 从 Chat Completions 嵌套格式展平成 Responses 格式
- function 名称超过 64 个字符时会截断；`mcp__...__tool` 会优先保留最后的 tool 名称
- 默认 `reasoning.effort="medium"`
- 默认 `reasoning.summary="auto"`
- 未传入 `model` 时使用 `MODELS` 中的第一项
- 显式传入的 `prompt_cache_key` 会保留到 Responses 请求体

Chat Completions 响应会把 Codex `message`、`reasoning`、`function_call` output item 分别还原为 `content`、`reasoning_content`、`tool_calls`。工具名缩短只发生在发往上游时，返回给客户端前会按原始请求里的工具列表恢复名称。

## 本地开发

安装依赖：

```bash
npm install
```

准备环境变量：

```bash
cp .env.example .env.local
```

类型检查：

```bash
npm run typecheck
```

本地启动：

```bash
npm run local
```

Vercel 本地服务通常运行在：

```text
http://localhost:3000
```

前端控制面板同样由 Vercel 静态托管：

```text
http://localhost:3000/
http://localhost:3000/dashboard
```

控制面板不会把 `ADMIN_TOKEN` 写入本地存储，刷新页面后需要重新输入。

## 部署

关联项目：

```bash
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
npm run typecheck
npx vercel build --prod --yes
npx vercel deploy --prod --prebuilt
```

## Cron

`vercel.json` 配置了两个定时任务：

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

Cron 使用 `CRON_SECRET` 鉴权。普通请求仍会在凭证接近过期时触发懒刷新。批量刷新会限制并发执行，避免凭证数量较多时长时间串行等待。清理任务只删除请求明细，不删除小时聚合。

## 常见问题

### 需要手动建表吗

不需要。只要 `DATABASE_URL` 指向可用 Postgres，服务会自动创建 `credentials`、`usage_events`、`usage_hourly` 表和索引。

### 为什么凭证显示 cooldown

上游返回 401、403、429、5xx，或者刷新失败时，服务会设置 `next_retry_at`。通用冷却时间由 `FAILURE_COOLDOWN_SECONDS` 控制；`HTTP 429: The usage limit has been reached` 会优先冷却到上游配额窗口的重置时间。

### 为什么凭证显示 expired

凭证带有过期时间，且当前时间已经超过 `expiresAt`。如果这条凭证有 `refresh_token`，下一次选择或定时刷新时会尝试刷新。

### 为什么刷新报 refresh_token_reused

OpenAI 的 `refresh_token` 只能使用一次。出现这个错误时，当前凭证里的 refresh token 已经失效，服务会自动停用这条凭证，需要重新登录并导入新的凭证 JSON。

### 为什么有的 400 不会切换凭证

400 通常表示请求参数不合法，切换凭证不能修复请求体。当前实现只对 401、403、429、5xx 做凭证轮换。

### 为什么请求明细最多只显示一部分

`/admin/usage/events` 是排查问题用的明细接口，默认返回 100 条，最多 500 条。控制面板当前查询最近 120 条明细。长期趋势和排行来自 `usage_hourly` 聚合，不依赖明细返回数量。
