# 开发文档

本文说明项目结构、运行流程、环境变量和部署流程。

## 项目结构

```text
api/index.ts                 Vercel Function 入口
public/index.html            前端控制面板，手动输入当前 ADMIN KEY 后调用管理接口
src/index.ts                 路由、CORS、接口分发
src/auth.ts                  Proxy/Admin/Cron 鉴权
src/codex.ts                 Responses 代理、上游请求、凭证轮换
src/codex-endpoint.ts        Codex 扩展端点路径与公共请求头构造
src/codex-payload.ts         请求规范化与 Responses Lite 适配
src/codex-models.ts          Codex 模型目录快照（lite 判断、思考等级映射、service tier）
src/codex-errors.ts          上游 response.failed 错误码到 HTTP 状态、Retry-After 和元数据响应头的映射
src/codex-affinity.ts        Codex 会话粘连凭据选择
src/codex-oauth.ts           Codex OAuth 登录（PKCE、授权码交换、凭证映射）
src/chat.ts                  Chat Completions 到 Responses 的转换
src/chat-payload.ts          Chat 请求字段兼容转换
src/credential-manager.ts    Postgres 凭证存储、刷新、状态维护
src/crypto.ts                凭证加密和解密
src/db.ts                    Postgres 共享连接
src/env.ts                   环境变量读取和默认值
src/jwt.ts                   id_token 身份解析
src/rate-limits.ts           Codex 配额快照解析和重置时间计算
src/settings.ts              控制面板配置
src/sse.ts                   SSE 编码、解析、读取
src/types.ts                 共享类型
src/usage.ts                 请求用量明细、小时聚合和清理
src/utils.ts                 JSON、错误、时间、字符串工具
tests/*.test.ts              Node test 单元测试
vercel.json                  Vercel Functions、Cron、rewrite 配置
```

## 请求流程

1. Vercel 将 `/v1/*`、`/admin/*`、`/cron/*` rewrite 到 `/api?__path=...`。
2. `api/index.ts` 调用 `handleRequest(request, loadEnv())`。
3. `src/index.ts` 根据路径分发：
   - `/healthz` 不需要鉴权，检查关键环境变量、数据库连通性和已配置密钥
   - `/v1/*` 使用控制面板 API KEY，初始值来自 `PROXY_API_KEY`
   - `/admin/*` 使用控制面板 ADMIN KEY，初始值来自 `ADMIN_TOKEN`
   - `/cron/refresh` 使用 `CRON_SECRET`
   - `/cron/cleanup` 使用 `CRON_SECRET`
4. `/v1/responses` 进入 `proxyResponses()`。
5. `/v1/chat/completions` 先由 `chatToResponses()` 转成 Responses 请求，再复用 Responses 的上游逻辑。
6. search、compact、images、memories 以及携带 `client_version` 的 models 请求进入 `proxyCodexJsonEndpoint()`，保持原生 JSON 格式并复用凭证轮换。
7. `fetchCodexWithRotation()` 从 Postgres 选择可用凭证，失败时按状态切换凭证。
8. Responses 上游使用 SSE 请求；下游非流式 Responses 会在服务端聚合为 JSON，扩展端点直接转发 JSON 响应流。
9. Responses 和 Chat 请求结束后，`src/usage.ts` 通过 `waitUntil` 异步写入 `usage_events` 明细和 `usage_hourly` 小时聚合，不阻塞代理响应。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | Postgres 连接串，需要支持 SSL |
| `PROXY_API_KEY` | 首次初始化 | `/v1/*` 接口访问密钥；多个 key 用英文逗号或换行分隔，后续可在控制面板更新 |
| `ADMIN_TOKEN` | 首次初始化 | `/admin/*` 管理接口访问密钥，后续可在控制面板更新 |
| `CRON_SECRET` | 是 | `/cron/refresh` 和 `/cron/cleanup` 定时任务密钥 |
| `CRED_ENCRYPTION_KEY` | 是 | 凭证加密密钥，建议使用长随机字符串 |
| `MODELS` | 否 | `/v1/models` 返回的模型列表，逗号分隔，默认 `gpt-6-astra,gpt-6-sol,gpt-6-luna,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4` |
| `CODEX_CLI_VERSION` | 否 | 客户端未发送 `User-Agent` 时用于生成 `codex_cli_rs/<版本>` 的 CLI 版本，默认 `0.156.0` |
| `RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS` | 否 | 成功请求后同一凭证配额快照最小刷新间隔，默认 `60`；usage limit 失败会强制刷新 |
| `REFRESH_LEAD_SECONDS` | 否 | token 到期前多少秒触发刷新，默认 `2 * 24 * 60 * 60` |
| `REFRESH_MIN_INTERVAL_SECONDS` | 否 | 强制刷新最小间隔，默认 `300` |
| `FAILURE_COOLDOWN_SECONDS` | 否 | 凭证失败后的通用冷却时间，默认 `300`；usage limit 命中或配额剩余低于 10% 时优先使用上游配额重置时间 |
| `REFRESH_LOCK_SECONDS` | 否 | 单条凭证刷新锁时间，默认 `120` |

示例：

```ini
DATABASE_URL=postgres://user:password@host/dbname?sslmode=require
PROXY_API_KEY=replace-with-local-proxy-key
ADMIN_TOKEN=replace-with-local-admin-token
CRON_SECRET=replace-with-local-cron-secret
CRED_ENCRYPTION_KEY=replace-with-a-long-random-secret
MODELS=gpt-6-astra,gpt-6-sol,gpt-6-luna,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4
CODEX_CLI_VERSION=0.156.0
RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS=60
REFRESH_LEAD_SECONDS=172800
REFRESH_MIN_INTERVAL_SECONDS=300
FAILURE_COOLDOWN_SECONDS=300
REFRESH_LOCK_SECONDS=120
```

`PROXY_API_KEY` 和 `ADMIN_TOKEN` 只负责首次初始化 `proxy_settings`。数据库中已经存在配置后，控制面板保存的 API KEY、ADMIN KEY 和 Fast mode 会成为当前运行配置。

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

`rate_limits_json` 保存请求完成后从 Codex `/wham/usage` 读取到的配额快照。成功请求按 `RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS` 对同一凭证节流，usage limit 失败会立即刷新以获得最新重置时间。快照包含主 `codex` 限额和 additional rate limits 的 `usedPercent`、窗口长度、重置时间、plan type、credits 等字段。控制面板用 `100 - usedPercent` 展示剩余额度；任意窗口剩余额度低于 10% 且存在未来重置时间时，服务会主动设置 `next_retry_at`。

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

`proxy_settings` 保存控制面板配置：

```sql
CREATE TABLE IF NOT EXISTS proxy_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  fast_mode BOOLEAN NOT NULL DEFAULT TRUE,
  proxy_api_key_hashes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  admin_token_hash TEXT,
  admin_token_display TEXT,
  updated_at BIGINT NOT NULL
);
```

`fast_mode` 默认为开启。它只是客户端未传 `service_tier` 时的兜底：开启时写入 `service_tier="priority"`，关闭时使用模型目录的 `defaultServiceTier`（`gpt-6-sol`、`gpt-6-luna` 为 `priority`，其他模型不发送）；客户端显式传入的 `service_tier` 始终优先（`default` 视为不发送）。最终值按 `src/codex-models.ts` 的模型目录过滤。

API KEY 和 ADMIN KEY 明文不写入数据库，只保存 SHA-256 和脱敏展示值。每条 API KEY 会返回稳定 `id`，控制面板用它保留、替换或删除单条 key；新增和替换时才提交明文。访问方维度会用当前控制面板 API KEY 配置返回 `KEY 1 · <脱敏值>` 这样的 `clientKey` 展示名，控制面板据此显示每个代理 key 的 token 用量。

## 凭证格式

只支持根对象扁平 token JSON。`access_token` 和 `refresh_token` 必须提供，其余字段可缺失或为空：

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
- 额外根字段会被忽略；不支持 `token_data` 嵌套格式、API key 凭证、单条凭证 `base_url` 或 `attributes.header:*`。
- 管理接口不会返回 token 明文。

## Token 刷新逻辑

OpenAI 的 `refresh_token` 是一次性的。刷新成功后，上游会返回新的 `refresh_token`，服务必须和新的 `access_token`、`id_token`、账号身份、过期时间一起持久化。否则下一次刷新会使用旧 token，触发 `refresh_token_reused`。

当前实现有两层保护：

- 同一 Vercel 实例内使用内存中的 `refreshInflight` 合并同一条凭证的刷新请求。
- 跨实例使用 `refresh_lock_until` 抢占数据库锁，并在锁内重新读取最新的 `encrypted_json`，避免拿旧密文继续消耗 refresh token。

如果刷新接口返回 `refresh_token_reused`，说明该 refresh token 已经被使用过。服务会自动停用这条凭证，代码无法恢复这类凭证，需要通过控制面板 OAuth 登录或重新导入新的凭证 JSON 来获取可用凭证。

管理端刷新和定时刷新语义不同：`/admin/credentials/{id}/refresh` 会强制刷新单条凭证 token 并同步额度快照；`/admin/credentials/refresh` 会强制刷新所有启用凭证 token 并同步所有启用凭证额度快照；`/cron/refresh` 只按 `REFRESH_LEAD_SECONDS` 刷新已到期或接近到期的启用凭证。

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

其中 `401` 会先像 Codex CLI 一样强制刷新当前凭证 token 并用同一凭证重试一次（`CredentialManager.recoverUnauthorized()`），仍失败才切换凭证。恢复时先重读数据库：其他实例已经换过 token 就直接复用；其他实例正持有刷新锁则最多等待 5 秒读取其结果，锁竞争不算刷新失败。失败路径（`markFailure`）不再清空 `refresh_lock_until`，只有刷新流程自己管理这把锁。

凭证成功计数在流式和非流式路径都只在收到 `response.completed` 后写入，HTTP 200 但中途断流按 502 记失败。上游在终态事件前 EOF 时，代理向客户端补发一个 `{"type":"error","code":"bad_upstream_response"}` 事件（Chat 为 error chunk 加 `[DONE]`）再结束流。客户端主动断开会触发流的 `cancel()`，代理随即取消上游读取，不记凭证失败，用量按状态 `499`、错误码 `client_cancelled` 记录。所有可用凭证耗尽时返回最后一次真实的上游错误（例如 429 与其 `Retry-After`），只有一开始就没有凭证才返回 `503 credential_unavailable`。刷新接口返回 `401`、`400 invalid_grant` 或 `refresh_token_expired`、`refresh_token_reused`、`refresh_token_invalidated` 时视为永久失败并停用凭证。

单次请求最多尝试 8 条凭证。失败凭证会写入 `last_error`、增加 `failure_count`，并设置 `next_retry_at`。如果上游返回 `HTTP 429: The usage limit has been reached`，或成功请求后的配额快照显示任意窗口剩余额度低于 10%，服务会读取这些窗口的未来 `reset_at`；多个窗口同时低于 10% 时取更晚的重置时间。没有可用重置时间时，失败路径退回 `Retry-After` 或 `FAILURE_COOLDOWN_SECONDS`。主动低余额冷却不增加 `failure_count`。

## Codex 请求规范化

Responses 入口会在转发前执行以下处理：

- `input` 为字符串时转成 user message
- 强制 `stream=true`
- 强制 `store=false`
- 强制 `parallel_tool_calls=true`（Responses Lite 模型除外，见下）
- 总是追加 `include` 项 `reasoning.encrypted_content`，其他 include 值保留
- 删除 `previous_response_id`、`prompt_cache_retention`、`safety_identifier`
- 删除 `max_output_tokens`、`max_completion_tokens`、`max_tokens`、`temperature`、`top_p`
- 删除 `truncation`、`context_management`、`user`
- `service_tier` 客户端优先、面板兜底、模型默认：客户端显式传入时使用客户端值（`default` 视为不发送），未传时 Fast mode 开启则写入 `priority`，关闭则取模型目录默认 tier（`gpt-6-sol`、`gpt-6-luna` 为 `priority`）；最终值按模型目录过滤，模型不支持的 tier 丢弃，目录之外的模型不过滤；`flex` 始终保留；`x-codex-guardian: reviewer` 请求不发送 `service_tier`
- `input[].role="system"` 改为 `developer`
- `web_search_preview` 和 `web_search_preview_2025_03_11` 改为 `web_search`
- `instructions` 缺失或为 `null` 时改为空字符串
- `reasoning.effort="ultra"` 按模型目录映射（`reasoningEffortForRequest()`）：取该模型的 `multi_agent_reasoning_effort`，没有则 `max`，仍不支持则该模型最高的非 ultra 等级；`persistent` 映射为 `disabled`
- `stream_options` 只保留 `reasoning_summary_delivery="sequential_cutoff"`，其他值和额外字段删除
- Responses Lite 模型（模型目录标记 `useResponsesLite`，或 `gpt-6`、`gpt-5.6`、`gpt-daybreak`、`codex-auto-review` 前缀）额外处理：`parallel_tool_calls` 固定为 `false`；`reasoning.context` 缺省时补为 `all_turns`；`input` 中没有 `additional_tools` 项时，按 Codex `create_tools_json_for_responses_lite` 的规则把 `function`、`custom` 工具包进 `{type:"namespace",name:"functions"}`（位于第一个函数工具的位置，客户端自带的 `functions` namespace 会被合并），其他工具保持原序，全部工具组成一个 `additional_tools` 项（无工具时 `tools: []`）前置到 `input`；非空 `instructions` 转成紧随其后的 developer message；两者带稳定 id `at_<uuidv5>`、`msg_<uuidv5>`，命名空间为 `uuidv5(OID, thread-id)`，name 分别为工具列表 JSON 和指令文本；顶层 `tools`、`instructions` 删除。已发送 `additional_tools` 项的 lite-aware 客户端输入保持原样
- Responses Lite 模型会删除 message、`function_call_output`、`custom_tool_call_output` 图片内容中的 `detail`
- `prompt_cache_key` 显式传入时保留；缺省时按客户端代理密钥生成稳定 UUID，并作为默认上游 `session-id`、`thread-id`
- 多凭据场景按 Codex 会话头做凭据粘连；粘连键只来自 `session-id`，没有该头时使用 `thread-id`，凭据不可用或上游返回可轮换错误时才切换备用凭据

发往上游 Codex 的请求头处理：

- `session-id` 和 `thread-id` 显式传入时使用请求头值；否则使用 `prompt_cache_key` 或代理自动生成的稳定 UUID
- `x-client-request-id` 显式传入时作为上游 `X-Client-Request-Id`；否则使用当前 `thread-id`
- `originator` 显式传入时透传；否则使用 `codex_cli_rs`
- `User-Agent` 显式传入时透传；否则生成 `codex_cli_rs/<有效版本>`；旧的 `USER_AGENT` 环境变量不再参与请求构造
- `version` 显式传入时透传；否则不发送（Codex CLI 0.153 已不再发送该头），`CODEX_CLI_VERSION` 只用于生成 `User-Agent`
- `x-codex-routing-hint` 显式传入时透传；否则按 `model=<slug>[;tier=<service_tier>]` 生成（Guardian reviewer 请求不生成）
- 凭证 id_token 标记 `chatgpt_account_is_fedramp` 时附加 `X-OpenAI-Fedramp: true`
- `x-oai-attestation`、`x-openai-subagent`、`x-openai-memgen-request`、`x-codex-turn-state`、`x-codex-turn-metadata`、`x-codex-window-id`、`x-codex-parent-thread-id`、`x-codex-installation-id`、`x-codex-beta-features`、`x-codex-guardian`、`x-openai-internal-codex-responses-lite` 存在时透传；Responses Lite 模型固定携带 `x-openai-internal-codex-responses-lite: true`
- 请求体 `Content-Encoding: zstd`（Codex CLI 默认）、`gzip`、`deflate`、`br` 由 `readJsonObject()` 用 Node 内置 `zlib` 解压；运行时缺少 zstd（Node < 22.15）时返回 `415 unsupported_content_encoding`
- 上游响应头 `x-codex-turn-state`、`openai-model`、`x-reasoning-included`、`x-models-etag`、`x-request-id`、`x-codex-promo-message`、`x-codex-active-limit`、`x-codex-rate-limit-reached-type` 原样返回；上游 `response.failed` 事件按 `src/codex-errors.ts` 映射为 `400`/`429`/`503`/`502`，`rate_limit_exceeded` 会从消息解析 `Retry-After`

Chat Completions 入口会先转成 Responses：

- `system` message 转成 `developer` message
- 顶层 `verbosity` 转成 `text.verbosity`，缺失时兼容读取 `text.verbosity`
- `assistant` message 使用 `output_text`
- `user` message 使用 `input_text`
- `image_url` 转成 `input_image`
- `file` 转成 `input_file`
- `tool` message 转成 `function_call_output`
- `assistant.tool_calls` 转成顶层 `function_call`
- function tools 从 Chat Completions 嵌套格式展平成 Responses 格式
- function 名称超过 64 个字符时会截断；`mcp__...__tool` 会优先保留最后的 tool 名称
- 传入 `reasoning` 时原样转发；仅传入 `reasoning_effort` 时转成 `reasoning.effort` 并补 `reasoning.summary="auto"`（GPT-6、GPT-5.6 等 Responses Lite 模型不补 `summary`，上游默认无 reasoning summary）
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

本地校验：

```bash
npm run check
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

控制面板不会把 `ADMIN_TOKEN` 写入本地存储，刷新页面后需要重新输入。API KEY 和 ADMIN KEY 明文只在保存配置时提交，接口响应只返回脱敏展示值。

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
npx vercel env add MODELS production
npx vercel env add CODEX_CLI_VERSION production
npx vercel env add RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS production
npx vercel env add REFRESH_LEAD_SECONDS production
npx vercel env add REFRESH_MIN_INTERVAL_SECONDS production
npx vercel env add FAILURE_COOLDOWN_SECONDS production
npx vercel env add REFRESH_LOCK_SECONDS production
```

`PROXY_API_KEY` 和 `ADMIN_TOKEN` 是首次初始化值；部署成功并连接控制面板后，可在“配置”页调整当前 API KEY、ADMIN KEY 和 Fast mode。

构建并发布：

```bash
npm run check
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

Cron 使用 `CRON_SECRET` 鉴权。普通请求仍会在凭证接近过期时触发懒刷新。Cron 刷新会参照 `REFRESH_LEAD_SECONDS`，管理端刷新则强制刷新启用凭证。批量刷新会限制并发执行，避免凭证数量较多时长时间串行等待。清理任务只删除请求明细，不删除小时聚合。

## 常见问题

### 需要手动建表吗

不需要。只要 `DATABASE_URL` 指向可用 Postgres，服务会自动创建 `credentials`、`usage_events`、`usage_hourly` 表和索引。

### 为什么凭证显示 cooldown

上游返回 401、403、429、5xx，刷新失败，或者配额快照显示任意窗口剩余额度低于 10% 时，服务会设置 `next_retry_at`。通用冷却时间由 `FAILURE_COOLDOWN_SECONDS` 控制；usage limit 命中和低余额主动冷却会优先冷却到对应配额窗口的重置时间。没有可用重置时间时，失败路径退回 `Retry-After` 或 `FAILURE_COOLDOWN_SECONDS`。

### 为什么凭证显示 expired

凭证带有过期时间，且当前时间已经超过 `expiresAt`。如果这条凭证有 `refresh_token`，下一次选择或定时刷新时会尝试刷新。

### 为什么刷新报 refresh_token_reused

OpenAI 的 `refresh_token` 只能使用一次。出现这个错误时，当前凭证里的 refresh token 已经失效，服务会自动停用这条凭证，需要通过控制面板 OAuth 登录或重新导入新的凭证 JSON 来获取可用凭证。

### 为什么有的 400 不会切换凭证

400 通常表示请求参数不合法，切换凭证不能修复请求体。当前实现只对 401、403、429、5xx 做凭证轮换。

### 为什么请求明细最多只显示一部分

`/admin/usage/events` 是排查问题用的明细接口，默认返回 100 条，最多 500 条。控制面板当前查询最近 120 条明细。长期趋势和排行来自 `usage_hourly` 聚合，不依赖明细返回数量。
