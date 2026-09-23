# Codex Vercel Proxy

Codex Vercel Proxy 是一个部署在 Vercel Functions 上的 Codex 代理服务。它提供 OpenAI 兼容的 `/v1/models`、`/v1/responses`、`/v1/chat/completions` 接口，并使用 Postgres 管理多账号凭证、凭证轮换、失败冷却和定时刷新。

项目同时提供一个单文件 Web 控制面板，用于导入、查看、启用、禁用、刷新和删除凭证，并展示请求用量、模型排行、凭据维度、访问方维度和请求明细。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAETSIRAX%2Fcodex-vercel-proxy&project-name=codex-vercel-proxy&repository-name=codex-vercel-proxy&env=DATABASE_URL,PROXY_API_KEY,ADMIN_TOKEN,CRON_SECRET,CRED_ENCRYPTION_KEY&envDescription=请填写%20Postgres%20连接串、初始%20PROXY_API_KEY、初始%20ADMIN_TOKEN、CRON_SECRET%20和%20CRED_ENCRYPTION_KEY。MODELS、CODEX_CLI_VERSION%20等变量可在部署后按需配置。)

## 控制面板预览

![Codex Proxy 控制面板](docs/assets/dashboard.png)

凭据池页右上角「导入凭据」抽屉内置 Codex OAuth 登录：

![Codex Proxy OAuth 登录](docs/assets/dashboard-oauth.png)

## 功能特性

- OpenAI 兼容接口：`/v1/models`、`/v1/responses`、`/v1/chat/completions`
- Codex 后端接口：`/v1/alpha/search`、`/v1/responses/compact`、`/v1/images/generations`、`/v1/images/edits`、`/v1/memories/trace_summarize`
- Responses Lite 模型：内置 GPT-6 系列（`gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna`）和 GPT-5.6 系列（`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`），按 Codex 模型目录自动以 Responses Lite 协议适配上游请求，工具、指令和稳定 id 的组装方式与 Codex CLI 一致；思考等级 `ultra`、`persistent` 按 Codex 的逐模型规则映射
- 请求体压缩：兼容 Codex CLI 默认开启的 zstd 请求体压缩（同时支持 gzip、deflate、br），运行时不支持时返回 `415` 并提示关闭 `enable_request_compression`
- OAuth 登录：控制面板内置 Codex OAuth 登录（PKCE），浏览器登录 OpenAI 账号后粘贴回调地址即可自动获取并导入凭证，无需手动准备 token JSON
- 凭证池管理：支持多条 Codex 凭证导入、状态查看、启用、禁用、刷新和删除
- 自动轮换：上游返回 `401` 时先刷新当前凭证 token 并原凭证重试（与 Codex CLI 一致），仍失败或返回 `403`、`429`、`5xx` 时自动尝试下一条可用凭证
- Token 刷新：支持到期前懒刷新和 Vercel Cron 定时刷新
- 请求规范化：对齐 Codex 上游预期参数，并兼容常见 OpenAI 客户端调用方式
- 缓存路由：保留 `prompt_cache_key`，缺省时自动为 Codex 请求生成稳定缓存键
- 用量统计：记录请求耗时、模型、凭证、缓存 token、思考 token 和汇总数据
- 用量分析：控制面板支持按 24 小时、7 天、30 天查看 Token 分类堆叠与请求数走势、模型/凭据/访问 KEY 聚合排行，请求明细可按「仅错误」「慢请求」筛选
- 请求配置：控制面板可切换 Fast mode（客户端未指定 `service_tier` 时的兜底 `priority`；关闭时按模型默认，`gpt-6-sol`、`gpt-6-luna` 默认仍为 Fast），并按行新增、替换、删除代理 API KEY 和 ADMIN KEY
- 加密存储：凭证私密字段使用 `CRED_ENCRYPTION_KEY` 加密后写入 Postgres
- 控制面板：访问 `/` 或 `/dashboard`，首屏输入服务地址和当前 ADMIN KEY 后管理凭证；连接后可在右上角连接胶囊中重新连接或清除，支持浅色/深色主题与键盘快捷键（`1`–`4` 切换页面，`/` 聚焦凭据搜索）
- 健康检查：公开 `/healthz` 端点，检查关键环境变量、数据库连通性和已配置密钥
- 单文件前端：控制面板位于 `public/index.html`，无需额外前端构建链路

## 架构

```text
Client / SDK
  |
  |  /v1/models
  |  /v1/responses
  |  /v1/chat/completions
  |  /v1/alpha/search
  |  /v1/responses/compact
  |  /v1/images/*
  |  /v1/memories/trace_summarize
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
  +-- src/codex-affinity.ts       Codex 会话粘连凭据选择
  +-- src/codex-endpoint.ts       Codex 扩展端点路由与公共请求头
  +-- src/codex-oauth.ts          Codex OAuth 登录（PKCE、授权码交换）
  +-- src/codex-payload.ts        请求规范化与 Responses Lite 适配
  +-- src/codex-models.ts         Codex 模型目录快照（lite、思考等级、service tier）
  +-- src/codex-errors.ts         上游错误码到 HTTP 状态和元数据响应头的映射
  +-- src/chat-payload.ts         Chat 请求字段兼容转换
  +-- src/codex.ts                上游请求、SSE、凭证轮换
  +-- src/credential-manager.ts   Postgres 凭证状态管理
  +-- src/rate-limits.ts          Codex 配额快照解析
  +-- src/usage.ts                请求用量明细和小时聚合
  +-- src/settings.ts             控制面板配置
  +-- src/db.ts                   Postgres 共享连接
  +-- src/env.ts                  环境变量读取和默认值
  +-- src/crypto.ts               凭证加密和解密
  +-- src/jwt.ts                  id_token 身份解析
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
| `PROXY_API_KEY` | 首次初始化 | `/v1/*` 代理接口访问密钥；多个 key 用英文逗号或换行分隔，后续可在控制面板更新 |
| `ADMIN_TOKEN` | 首次初始化 | `/admin/*` 和控制面板访问密钥，后续可在控制面板更新 |
| `CRON_SECRET` | 是 | `/cron/refresh` 和 `/cron/cleanup` 定时任务接口密钥 |
| `CRED_ENCRYPTION_KEY` | 是 | 凭证加密密钥，建议使用长随机字符串 |
| `MODELS` | 否 | `/v1/models` 返回的模型列表，逗号分隔，默认 `gpt-6-astra,gpt-6-sol,gpt-6-luna,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4` |
| `CODEX_CLI_VERSION` | 否 | 客户端未发送 `User-Agent` 时用于生成 `codex_cli_rs/<版本>` 的 Codex CLI 版本，默认 `0.156.0`（`gpt-6-sol`、`gpt-6-luna` 要求 0.155.0 及以上） |
| `RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS` | 否 | 成功请求后同一凭证配额快照最小刷新间隔，默认 `60`；usage limit 失败会强制刷新 |
| `REFRESH_LEAD_SECONDS` | 否 | token 到期前多少秒触发刷新，默认 `2 * 24 * 60 * 60` |
| `REFRESH_MIN_INTERVAL_SECONDS` | 否 | 强制刷新最小间隔，默认 `300` |
| `FAILURE_COOLDOWN_SECONDS` | 否 | 凭证失败后的通用冷却时间，默认 `300`；usage limit 命中或配额剩余低于 10% 时优先使用上游配额重置时间 |
| `REFRESH_LOCK_SECONDS` | 否 | 单条凭证刷新锁时间，默认 `120` |

`PROXY_API_KEY` 和 `ADMIN_TOKEN` 是首次创建 `proxy_settings` 时使用的初始值。部署后可以在控制面板的“配置”页修改 API KEY、ADMIN KEY 和 Fast mode，后续鉴权会以数据库中的当前配置为准。

### 手动部署

```bash
npm install
npm run check
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

其中 `PROXY_API_KEY` 和 `ADMIN_TOKEN` 用作首次初始化密钥；`MODELS`、`CODEX_CLI_VERSION` 和刷新/冷却相关变量是可选配置。

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
MODELS=gpt-6-astra,gpt-6-sol,gpt-6-luna,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4
CODEX_CLI_VERSION=0.156.0
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

本地校验：

```bash
npm run check
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

在控制面板中输入服务地址和当前 ADMIN KEY。首次部署后，当前 ADMIN KEY 为环境变量 `ADMIN_TOKEN`；连接成功后，可以导入 Codex 凭证 JSON 并查看凭证状态。

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

### Codex CLI 配置

在 `~/.codex/config.toml` 中使用独立 provider，并显式关闭 Responses WebSocket：

```toml
model_provider = "codex_vercel_proxy"

[model_providers.codex_vercel_proxy]
name = "OpenAI"
base_url = "https://<vercel-domain>/v1"
env_key = "CODEX_PROXY_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
```

在启动 Codex CLI 前设置代理 API KEY：

```bash
export CODEX_PROXY_API_KEY="<PROXY_API_KEY>"
```

`name = "OpenAI"` 使 Codex 启用 OpenAI 的搜索、图片和远程压缩扩展；`supports_websockets = false` 让请求固定使用当前代理支持的 HTTP/SSE 传输。代理场景建议使用以上独立 provider 配置；`openai_base_url` 会保留内置 OpenAI provider 的 WebSocket 能力。

Vercel Hobby 套餐的函数时长上限为 300 秒，因此仓库中的 `maxDuration` 保持为 `300`。推理超过五分钟时，Vercel 会终止请求，包括仍在发送的 SSE 响应。

导入单条凭证：

```bash
curl -X POST "https://<vercel-domain>/admin/credentials/import" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  --data-binary @/path/to/codex-token.json
```

## OAuth 登录

除手动导入 token JSON 外，凭据池页右上角的「导入凭据」抽屉内置 Codex OAuth 登录（PKCE），无需自备 token：

1. 点击「开始登录」，在新标签页登录 OpenAI 账号；
2. 登录成功后浏览器会跳转到 `http://localhost:1455/auth/callback?code=...`，由于本服务不在本地监听该端口，页面打不开属于正常现象；
3. 复制浏览器地址栏中完整的回调地址，粘贴回抽屉并点击「完成登录并导入」，服务会自动换取 token 并入库。

OAuth 请求的 scope（含 `api.connectors.read`、`api.connectors.invoke`）和 `originator=codex_cli_rs` 参数与 Codex CLI 一致。OAuth 客户端复用 Codex CLI 的固定回环回调地址，因此这里采用「手动粘贴回调」的无状态实现，PKCE `code_verifier` 仅在当前浏览器内存中短暂保存。对应管理接口为 `POST /admin/oauth/codex/start` 和 `POST /admin/oauth/codex/complete`，详见[接口文档](docs/API_CN.md)。

## 凭证格式

只支持根对象扁平字段的 token JSON 文件。`access_token` 和 `refresh_token` 必须提供，其余字段可缺失或为空：

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

额外根字段会被忽略；不支持 `token_data` 嵌套格式、API key 凭证或单条凭证自定义上游配置。

管理接口只返回凭证状态，不返回 token 明文。

## Token 刷新

OpenAI 的 `refresh_token` 是一次性 token。刷新成功后，服务会把新的 `access_token`、`refresh_token`、`id_token`、账号身份、过期时间和最后刷新时间一起写回 Postgres。

上游对某条凭证返回 `401` 时，服务会像 Codex CLI 一样先强制刷新该凭证 token 并用同一凭证重试一次，仍然失败才切换到下一条凭证。

如果凭证已经出现 `refresh_token_reused`、`refresh_token_expired`、`refresh_token_invalidated`，或刷新接口返回 `401`、`400 invalid_grant`，服务会自动停用这条凭证。代码无法原地修复，需要重新获取凭证：使用控制面板的 OAuth 登录，或重新登录导出新的凭证 JSON 再导入。

如果上游返回 `HTTP 429: The usage limit has been reached`，或成功请求后的配额快照显示任意窗口剩余额度低于 10%，服务会读取这些窗口的未来 `reset_at`，把这条凭证冷却到对应窗口重置时间；多个窗口同时低于 10% 时取更晚的重置时间。没有可用重置时间时，失败路径才退回 `Retry-After` 或 `FAILURE_COOLDOWN_SECONDS`。

控制面板的单条刷新会强制刷新该凭证 token，并立即同步该凭证额度快照。控制面板的全局“刷新凭据”会强制刷新所有启用凭证 token，再同步所有启用凭证额度快照，不受 `REFRESH_LEAD_SECONDS` 限制。

## Responses Lite 模型与思考等级

代理内置一份 Codex 模型目录快照（`src/codex-models.ts`，来源于 openai/codex main 分支 2026-09-23 的 `models.json`），用于判断哪些模型走 Responses Lite 协议、各模型支持的思考等级、service tier 和默认 service tier。GPT-6 系列（`gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna`）、GPT-5.6 系列（`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`）、`gpt-daybreak-*` 和 `codex-auto-review` 在上游使用 Responses Lite 协议；目录之外的模型按 `gpt-6`、`gpt-5.6`、`gpt-daybreak`、`codex-auto-review` 前缀判断。代理会对这些模型自动完成适配：

- 上游请求附带 `x-openai-internal-codex-responses-lite: true` 请求头，`parallel_tool_calls` 固定为 `false`，`reasoning.context` 缺省时补为 `all_turns`；
- Lite 请求会清除 message、`function_call_output` 和 `custom_tool_call_output` 图片内容中的 `detail` 字段；
- 工具和指令的组装方式与 Codex CLI 完全一致：`function`、`custom` 工具会被包进 `{"type":"namespace","name":"functions","tools":[...]}`（放在第一个函数工具原来的位置），`web_search`、`tool_search` 等其他工具保持原顺序，整个工具列表作为一个 `additional_tools` 项（没有工具时为空列表）前置到 `input`，顶层 `tools` 和 `instructions` 不再发送；非空 `instructions` 转换为紧随其后的 developer 消息。这两个前缀项带有稳定 id（`at_<uuidv5>`、`msg_<uuidv5>`，命名空间由当前 `thread-id` 派生，与 Codex 相同），同一线程内内容不变时 id 不变，便于上游缓存前缀；
- 如果客户端（如 Codex CLI 0.144+）已经发送 `additional_tools` 项，输入保持原样；
- 托管工具（如 `web_search`）会随其他工具一起进入 `additional_tools`。Codex CLI 自身不会给 lite 模型发送托管搜索（其搜索由 CLI 本地 `web.run` 工具执行），lite 上游是否接受由上游决定；需要服务端 `web_search` 请使用 `gpt-5.5` 及更早模型；
- 思考等级按模型目录映射：`ultra` 是 Codex 客户端本地概念，发送上游时取该模型的 `multi_agent_reasoning_effort`（如 `gpt-6-astra` 为 `xhigh`），没有则取 `max`（如 `gpt-6-sol`、`gpt-6-luna`），仍不支持时取该模型最高的非 ultra 等级（如 `gpt-5.5` 为 `xhigh`）；`persistent` 映射为 `disabled`；
- 无论请求是否带 `reasoning`，都会追加 `include: ["reasoning.encrypted_content"]`，与 Codex CLI 一致；
- Codex App/CLI 传入的 `User-Agent` 和 `version` 会原样转发。普通客户端缺少 `User-Agent` 时，代理用 `CODEX_CLI_VERSION`（默认 `0.156.0`）生成 `codex_cli_rs/<版本>`；当前 Codex CLI 已不再发送 `version` 请求头，代理也不会伪造它。旧的 `USER_AGENT` 环境变量不再参与请求构造。

`gpt-5.5` 及更早模型不受 lite 适配影响，仍按原有方式转发。

### service_tier

`service_tier` 采用客户端优先、面板兜底、模型默认的策略：客户端显式传入时使用客户端值（`default` 视为不发送，也会关闭所有兜底）；客户端未传时，控制面板开启 Fast mode 则写入 `priority`，关闭时使用模型目录中的默认 tier（`gpt-6-sol`、`gpt-6-luna` 默认 `priority`，与 Codex 一致；其他模型不发送）。最终值会按模型目录过滤，模型不支持的 tier（例如 `gpt-daybreak-*` 不支持 `priority`，`gpt-5.6-sol` 已不再提供 `ultrafast`）会被丢弃，目录之外的模型不做过滤；`flex` 是 API 请求选项，与 Codex 一样始终原样发送。Guardian 审查请求（`x-codex-guardian: reviewer`）与 Codex 一致，不发送 `service_tier`，也不生成 `x-codex-routing-hint`。上游请求头 `x-codex-routing-hint` 会按 `model=<slug>[;tier=<tier>]` 生成（客户端已传时透传）。

### 请求体压缩

Codex CLI 默认开启 `enable_request_compression`，用 zstd 压缩 `/v1/responses` 请求体。代理使用 Node.js 内置 `zlib` 解压 `Content-Encoding: zstd`（需要 Node.js 22.15+，Vercel 的 Node 22 运行时满足），同时支持 `gzip`、`deflate`、`br`。运行时缺少 zstd 支持时返回 `415 unsupported_content_encoding`，请在 Codex 配置中设置 `enable_request_compression = false` 或升级运行时。

## Prompt Caching

服务会保留客户端显式传入的 `prompt_cache_key`。如果请求没有传入该字段，会按调用方的代理密钥生成稳定 UUID，并把同一个值同时作为请求体 `prompt_cache_key` 以及默认上游 `session-id`、`thread-id` 发送。

客户端显式传入 `session-id` 或 `thread-id` 请求头时，这两个请求头会用于上游请求；`prompt_cache_key` 仍按请求体字段或代理自动生成值处理。服务还会透传 `version`、`x-codex-turn-state`、`x-codex-turn-metadata`、`x-codex-window-id`、`x-codex-parent-thread-id`、`x-codex-installation-id`、`x-codex-beta-features`、`x-codex-routing-hint` 和 `x-codex-guardian`，`x-client-request-id` 缺省时使用当前 `thread-id`；FedRAMP 账号（id_token 中 `chatgpt_account_is_fedramp` 为真）会附加 `X-OpenAI-Fedramp: true`。上游响应中的 `x-codex-turn-state`、`openai-model`、`x-reasoning-included`、`x-models-etag`、`x-request-id`、`x-codex-promo-message`、`x-codex-active-limit`、`x-codex-rate-limit-reached-type` 会原样返回给客户端。

多凭据场景下，服务会按 Codex 会话头做凭据粘连。粘连键只来自 `session-id`，没有该头时使用 `thread-id`；没有这两个请求头时保留原有按 `last_used_at` 选择凭据的行为。该凭据不可用或触发可轮换错误时，当前请求才会切到备用凭据。

配置多个 API KEY 时，每个 key 会得到独立的缓存身份和用量统计。数据库只保存 key 的 SHA-256，控制面板按当前配置中的 key 顺序展示脱敏后的访问 KEY 用量。

实际是否命中缓存取决于上游服务和请求前缀是否完全一致。命中情况可通过上游 usage 中的 `input_tokens_details.cached_tokens` 等字段观察。

## 数据库

服务首次访问相关逻辑时会自动创建数据库表和索引：

- `credentials`：保存加密后的凭证正文、启用状态、错误信息、刷新锁、配额快照、成功和失败计数
- `usage_events`：保存最近请求明细，用于请求表格、错误率、平均耗时和 p95 分析
- `usage_hourly`：保存小时聚合，用于请求走势、token 汇总、模型排行、凭据维度和访问 KEY 用量
- `proxy_settings`：保存控制面板配置，包含 Fast mode、代理 API KEY 哈希和 ADMIN KEY 哈希

`credentials.encrypted_json` 字段保存加密后的凭证正文，加密密钥来自 `CRED_ENCRYPTION_KEY`。成功请求完成后，服务会按 `RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS` 节流，用实际使用的账号查询 Codex `/wham/usage`，把当前配额窗口、剩余百分比所需的 `used_percent`、重置时间和 credits 信息写入 `credentials.rate_limits_json`；usage limit 失败路径会跳过节流并立即刷新。任意窗口剩余额度低于 10% 且存在未来重置时间时，服务会主动设置 `next_retry_at`。

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

`/cron/refresh` 按 `REFRESH_LEAD_SECONDS` 刷新已到期或接近到期的启用凭证。`/cron/cleanup` 清理 90 天以前的 `usage_events` 明细，控制存储成本和查询规模。小时聚合表会长期保留。

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
src/codex-endpoint.ts        Codex 扩展端点路径与公共请求头构造
src/codex-payload.ts         请求规范化与 GPT-5.6 Responses Lite 适配
src/codex-affinity.ts        Codex 会话粘连凭据选择
src/chat.ts                  Chat Completions 转 Responses
src/chat-payload.ts          Chat 请求字段兼容转换
src/credential-manager.ts    Postgres 凭证存储、刷新、状态维护
src/rate-limits.ts           Codex 配额快照解析和重置时间计算
src/db.ts                    Postgres 共享连接
src/env.ts                   环境变量读取和默认值
src/settings.ts              控制面板配置
src/usage.ts                 请求用量明细和小时聚合
src/crypto.ts                凭证加密和解密
src/jwt.ts                   id_token 身份解析
src/sse.ts                   SSE 编码、解析、读取
src/types.ts                 共享类型
src/utils.ts                 JSON、错误、时间、字符串工具
tests/*.test.ts              Node test 单元测试
vercel.json                  Vercel Functions、Cron、rewrite 配置
```

## 安全

- 不要将 `.env.local`、`.dev.vars`、数据库连接串、服务密钥或凭证 JSON 提交到公开仓库。
- `PROXY_API_KEY` 和 `ADMIN_TOKEN` 应使用不同的随机值；首次启动时会写入控制面板配置，之后可在控制面板更换。
- 控制面板不会返回 API KEY 或 ADMIN KEY 明文，只展示脱敏后的配置项；API KEY 支持单条新增、替换和删除后再保存。
- `CRED_ENCRYPTION_KEY` 应长期稳定保存；更换后需要重新导入凭证。
- 控制面板只在当前页面内存中保存 `ADMIN_TOKEN`，不会写入浏览器本地存储。

## 友情链接

- [LINUX DO](https://linux.do/) - 新的理想型社区

## 许可证

本项目使用 GNU General Public License v3.0 许可证。完整许可证文本见 [LICENSE](LICENSE)。
