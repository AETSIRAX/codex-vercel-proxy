# 接口文档

基础地址：

```text
https://<vercel-domain>
```

本项目暴露以下接口：

- OpenAI 兼容接口：`/v1/*`
- 管理接口：`/admin/*`
- 定时任务接口：`/cron/refresh`、`/cron/cleanup`
- 健康检查接口：`/healthz`

## 鉴权

除 `/healthz` 外，所有接口都需要鉴权。支持两种传参方式：

```http
Authorization: Bearer <token>
```

或：

```http
x-api-key: <token>
```

不同接口使用不同密钥：

| 路径 | 密钥 |
| --- | --- |
| `/v1/*` | `PROXY_API_KEY`，可用英文逗号或换行配置多个 key |
| `/admin/*` | `ADMIN_TOKEN` |
| `/cron/refresh`、`/cron/cleanup` | `CRON_SECRET` |
| `/healthz` | 无需鉴权 |

鉴权失败响应：

```json
{
  "error": {
    "message": "invalid bearer token",
    "type": "invalid_request_error",
    "code": "unauthorized"
  }
}
```

## 通用错误格式

服务自身生成的错误统一为：

```json
{
  "error": {
    "message": "error message",
    "type": "invalid_request_error",
    "code": "error_code"
  }
}
```

上游 Codex 返回的错误会尽量原样透传，响应状态码也沿用上游状态码。

## GET /healthz

公开健康检查端点，不返回凭证数量、数据库地址、模型列表或其他部署细节。

当关键环境变量存在且数据库可以连通时返回 `200`。缺少关键环境变量或数据库连接失败时返回 `503`。响应体为空。

请求：

```bash
curl -i "https://<vercel-domain>/healthz"
```

## GET /v1/models

返回 `MODELS` 环境变量配置的模型列表。未配置时默认返回 `gpt-5.5,gpt-5.4`。

请求：

```bash
curl "https://<vercel-domain>/v1/models" \
  -H "Authorization: Bearer <PROXY_API_KEY>"
```

响应：

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-5.5",
      "object": "model",
      "created": 0,
      "owned_by": "codex"
    },
    {
      "id": "gpt-5.4",
      "object": "model",
      "created": 0,
      "owned_by": "codex"
    }
  ]
}
```

## POST /v1/responses

OpenAI Responses 兼容入口。请求会被规范化后转发到 Codex 上游 `/responses`。

请求：

```bash
curl "https://<vercel-domain>/v1/responses" \
  -H "Authorization: Bearer <PROXY_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "input": "Say hello in one short sentence."
  }'
```

非流式响应：

```json
{
  "id": "resp_...",
  "object": "response",
  "created_at": 1770000000,
  "status": "completed",
  "model": "gpt-5.4",
  "output": [
    {
      "type": "message",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "Hello."
        }
      ]
    }
  ],
  "usage": {
    "input_tokens": 10,
    "output_tokens": 3,
    "total_tokens": 13
  }
}
```

流式请求：

```bash
curl -N "https://<vercel-domain>/v1/responses" \
  -H "Authorization: Bearer <PROXY_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "stream": true,
    "input": "Say hello."
  }'
```

流式响应为 SSE：

```text
data: {"type":"response.created",...}

data: {"type":"response.output_text.delta","delta":"Hello",...}

data: {"type":"response.completed","response":{...}}
```

### Responses 请求处理规则

转发前会执行以下处理：

| 字段 | 行为 |
| --- | --- |
| `input` 字符串 | 转为 `[{type:"message",role:"user",content:[...]}]` |
| `stream` | 强制上游为 `true` |
| `store` | 强制为 `false` |
| `parallel_tool_calls` | 强制为 `true` |
| `include` | 强制为 `["reasoning.encrypted_content"]` |
| `prompt_cache_key` | 显式传入时原样保留；缺省时按代理密钥生成稳定 UUID，并同步写入上游 `Session_id` |
| `input[].role="system"` | 改为 `developer` |
| `instructions` 缺失或 `null` | 改为空字符串 |
| `web_search_preview*` | 改为 `web_search` |
| `service_tier` | 只保留 `priority` |

以下字段会被删除：

```text
previous_response_id
prompt_cache_retention
safety_identifier
stream_options
max_output_tokens
max_completion_tokens
max_tokens
temperature
top_p
truncation
context_management
user
```

## POST /v1/chat/completions

OpenAI Chat Completions 兼容入口。服务会把请求转换为 Responses 请求，再调用 Codex。

如果请求没有传入 `model`，服务会使用 `MODELS` 中的第一项作为默认模型。

请求：

```bash
curl "https://<vercel-domain>/v1/chat/completions" \
  -H "Authorization: Bearer <PROXY_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [
      {"role": "user", "content": "请只回复两个汉字：正常"}
    ]
  }'
```

响应：

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1770000000,
  "model": "gpt-5.4",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "正常"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 2,
    "total_tokens": 12
  }
}
```

流式请求：

```bash
curl -N "https://<vercel-domain>/v1/chat/completions" \
  -H "Authorization: Bearer <PROXY_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Say hello."}
    ]
  }'
```

流式响应：

```text
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### Chat 支持的输入

| Chat 字段 | 转换结果 |
| --- | --- |
| `messages[].role="system"` | Responses `developer` message |
| `messages[].role="user"` | Responses `user` message |
| `messages[].role="assistant"` | Responses `assistant` message |
| `messages[].role="tool"` | Responses `function_call_output` |
| `content` 字符串 | `input_text` 或 `output_text` |
| `content[].type="text"` | `input_text` 或 `output_text` |
| `content[].type="image_url"` | `input_image`，仅 user |
| `content[].type="file"` | `input_file`，仅 user |
| `assistant.tool_calls` | Responses 顶层 `function_call` |
| `tools[].type="function"` | 展平成 Responses function tool |
| `tool_choice` | 字符串原样保留；function object 会展平 |
| `response_format` | 转为 `text.format` |
| `text.verbosity` | 转为 `text.verbosity` |
| `reasoning_effort` | 转为 `reasoning.effort` |
| `prompt_cache_key` | 原样传给 Responses `prompt_cache_key` |

Chat 转换默认值：

```json
{
  "instructions": "",
  "reasoning": {
    "effort": "medium",
    "summary": "auto"
  },
  "parallel_tool_calls": true,
  "include": ["reasoning.encrypted_content"],
  "store": false
}
```

### Chat 响应处理规则

- 非流式响应会从 Codex `response.output` 中还原 `message.content`、`message.reasoning_content` 和 `message.tool_calls`。
- 流式响应会把 `response.output_text.delta` 转成 `delta.content`，把 `response.reasoning_summary_text.delta` 转成 `delta.reasoning_content`。
- 工具调用会从 Codex `function_call` 事件还原为 Chat Completions 的 `tool_calls`；如果请求时函数名因 Codex 长度限制被缩短，响应会恢复成客户端原始函数名。
- 当响应包含工具调用时，`finish_reason` 为 `tool_calls`，否则为 `stop`。

## GET /admin/health

返回服务状态和所有凭证状态，不返回 token。

请求：

```bash
curl "https://<vercel-domain>/admin/health" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

响应：

```json
{
  "ok": true,
  "credential_count": 40,
  "available_count": 1,
  "credentials": [
    {
      "id": "codex-...",
      "label": "user@example.com",
      "enabled": true,
      "status": "available",
      "accountId": "acc_...",
      "email": "user@example.com",
      "expiresAt": "2026-05-06T12:00:00Z",
      "lastRefresh": "2026-05-06T11:00:00Z",
      "successCount": 10,
      "failureCount": 0,
      "rateLimitsUpdatedAt": "2026-05-07T02:01:00.000Z",
      "rateLimits": [
        {
          "limitId": "codex",
          "planType": "pro",
          "primary": {
            "usedPercent": 42,
            "windowMinutes": 300,
            "resetAt": 1770000000
          },
          "secondary": {
            "usedPercent": 5,
            "windowMinutes": 10080,
            "resetAt": 1770500000
          }
        }
      ],
      "updatedAt": "2026-05-07T02:00:00.000Z"
    }
  ]
}
```

凭证处于冷却或异常状态时，还可能返回 `nextRetryAt` 和 `lastError`。成功请求完成后，服务会按 `RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS` 节流，用实际使用的账号查询 Codex 配额接口，并在凭证状态中返回 `rateLimits` 和 `rateLimitsUpdatedAt`；usage limit 失败会立即刷新配额以获取重置时间。剩余额度可按 `100 - usedPercent` 计算。

凭证状态：

| 状态 | 含义 |
| --- | --- |
| `available` | 可被选择 |
| `disabled` | 已手动禁用 |
| `cooldown` | 失败后冷却中 |
| `expired` | 已过期，等待刷新或手动处理 |
| `refresh_due` | 接近过期，下一次选择或 Cron 会刷新 |
| `invalid` | 缺少可用 access token 或 refresh token |

## GET /admin/credentials

返回凭证状态列表。

请求：

```bash
curl "https://<vercel-domain>/admin/credentials" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

响应：

```json
{
  "data": [
    {
      "id": "codex-...",
      "label": "user@example.com",
      "enabled": true,
      "status": "available",
      "successCount": 10,
      "failureCount": 0,
      "updatedAt": "2026-05-07T02:00:00.000Z"
    }
  ]
}
```

## POST /admin/credentials/import

导入单条或多条凭证。

单条导入：

```bash
curl -X POST "https://<vercel-domain>/admin/credentials/import" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  --data-binary @/path/to/codex-token.json
```

批量导入：

```bash
curl -X POST "https://<vercel-domain>/admin/credentials/import" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  --data-binary @/path/to/batch.json
```

单条请求体：

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

只支持这种根对象扁平字段格式，不支持 `metadata`、`token_data`、API key 凭证或单条凭证自定义上游配置。

单条响应：

```json
{
  "id": "codex-...",
  "label": "user@example.com",
  "disabled": false
}
```

批量响应：

```json
{
  "data": [
    {
      "id": "codex-...",
      "label": "user@example.com",
      "disabled": false
    }
  ]
}
```

## POST /admin/credentials/refresh

刷新凭据池。该接口会先刷新所有到期或接近到期的启用凭证 token，再用所有仍启用且有可用 access token 的凭据刷新 Codex 配额快照。

token 刷新失败会按凭据失败逻辑更新 `lastError`、`failureCount` 和 `nextRetryAt`；如果 refresh token 已永久失效，会停用该凭据。配额刷新失败只计入 `rateLimits.failed` 并写日志，不会改变凭据可用状态或代理响应。

请求：

```bash
curl -X POST "https://<vercel-domain>/admin/credentials/refresh" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

响应：

```json
{
  "checked": 40,
  "refreshed": 1,
  "failed": 0,
  "rateLimits": {
    "checked": 40,
    "refreshed": 39,
    "failed": 1
  }
}
```

顶层 `checked`、`refreshed`、`failed` 表示 token 到期刷新结果；`rateLimits` 表示额度快照刷新结果。

## POST /admin/credentials/{id}/enable

启用凭证，并清除 `next_retry_at` 和刷新锁。

请求：

```bash
curl -X POST "https://<vercel-domain>/admin/credentials/<id>/enable" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

响应为启用后的凭证状态。

## POST /admin/credentials/{id}/disable

禁用凭证。

请求：

```bash
curl -X POST "https://<vercel-domain>/admin/credentials/<id>/disable" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

响应为禁用后的凭证状态。

## POST /admin/credentials/{id}/refresh

手动刷新单条凭证。

请求：

```bash
curl -X POST "https://<vercel-domain>/admin/credentials/<id>/refresh" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

响应为刷新后的凭证状态。没有 `refresh_token` 的凭证会返回错误。

OpenAI 的 `refresh_token` 是一次性的。刷新成功后，服务会保存上游返回的新 `refresh_token`。如果返回 `refresh_token_reused`，说明当前凭证已经失效，服务会自动停用这条凭证，需要重新登录并导入新的凭证 JSON。

## DELETE /admin/credentials/{id}

删除单条凭证。

请求：

```bash
curl -X DELETE "https://<vercel-domain>/admin/credentials/<id>" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

响应：

```json
{
  "deleted": true
}
```

## GET /admin/usage/summary

按小时聚合查看请求量和 token 用量。统计来自上游 `response.completed` 的 `usage` 字段，不保存请求正文或响应正文。

该接口直接返回数据库中存在的小时聚合行，不主动补齐空小时或空日期。控制面板会在前端按当前范围补齐缺失时间段，`24h` 按小时展示，`7d` 和 `30d` 按日期展示。

访问方维度只在数据库中保存请求 key 的 SHA-256。管理接口会按当前 `PROXY_API_KEY` 环境变量反查并返回脱敏后的 `clientKey`，用于区分每个代理 key 的 token 用量。

查询参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `from` | 否 | ISO 时间或毫秒时间戳，默认最近 24 小时 |
| `to` | 否 | ISO 时间或毫秒时间戳，默认当前时间 |

请求：

```bash
curl "https://<vercel-domain>/admin/usage/summary?from=2026-05-10T00:00:00Z" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

响应：

```json
{
  "from": "2026-05-10T00:00:00.000Z",
  "to": "2026-05-11T00:00:00.000Z",
  "total": {
    "requestCount": 12,
    "inputTokens": 1000,
    "outputTokens": 500,
    "totalTokens": 1500,
    "cachedTokens": 300,
    "reasoningTokens": 120
  },
  "byHour": [],
  "byModel": [],
  "byCredential": [],
  "byClient": [
    {
      "clientHash": "sha256...",
      "clientKey": "KEY 1 · abc123...xyz789",
      "requestCount": 12,
      "inputTokens": 1000,
      "outputTokens": 500,
      "totalTokens": 1500,
      "cachedTokens": 300,
      "reasoningTokens": 120
    }
  ]
}
```

## GET /admin/usage/events

查看最近的请求明细。该接口用于排查问题，默认返回最近 100 条，最多 500 条。

查询参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `from` | 否 | ISO 时间或毫秒时间戳，默认最近 24 小时 |
| `to` | 否 | ISO 时间或毫秒时间戳，默认当前时间 |
| `limit` | 否 | 返回条数，范围 `1` 到 `500` |

请求：

```bash
curl "https://<vercel-domain>/admin/usage/events?limit=50" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

响应：

```json
{
  "from": "2026-05-10T00:00:00.000Z",
  "to": "2026-05-11T00:00:00.000Z",
  "data": [
    {
      "id": "uuid",
      "createdAt": "2026-05-10T01:00:00.000Z",
      "completedAt": "2026-05-10T01:00:01.200Z",
      "durationMs": 1200,
      "endpoint": "/v1/responses",
      "model": "gpt-5.5",
      "stream": true,
      "credentialId": "codex-...",
      "clientHash": "sha256...",
      "clientKey": "KEY 1 · abc123...xyz789",
      "clientRequestId": "optional-client-request-id",
      "upstreamResponseId": "resp_...",
      "statusCode": 200,
      "requestCount": 1,
      "inputTokens": 100,
      "outputTokens": 50,
      "totalTokens": 150,
      "cachedTokens": 20,
      "reasoningTokens": 10
    }
  ]
}
```

## GET 或 POST /cron/refresh

供 Vercel Cron 调用，也可以手动触发。鉴权使用 `CRON_SECRET`。

请求：

```bash
curl "https://<vercel-domain>/cron/refresh" \
  -H "Authorization: Bearer <CRON_SECRET>"
```

响应：

```json
{
  "checked": 40,
  "refreshed": 1,
  "failed": 0
}
```

## GET 或 POST /cron/cleanup

供 Vercel Cron 调用，也可以手动触发。鉴权使用 `CRON_SECRET`。

该接口会删除 90 天以前的 `usage_events` 请求明细，返回删除数量。`usage_hourly` 小时聚合不会被清理。

请求：

```bash
curl "https://<vercel-domain>/cron/cleanup" \
  -H "Authorization: Bearer <CRON_SECRET>"
```

响应：

```json
{
  "deleted": 1280
}
```

## CORS

所有响应都会附带：

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: authorization,content-type,x-api-key,x-client-request-id
Access-Control-Allow-Methods: GET,POST,DELETE,HEAD,OPTIONS
```

`OPTIONS` 预检请求直接返回 `204`。
