import { waitUntil } from "@vercel/functions";
import { database, type Sql } from "./db.js";
import { proxyApiKeys, type AppEnv } from "./env.js";
import type { JsonValue, SelectedCredential } from "./types.js";
import {
  isRecord,
  lazySingleton,
  normalizeErrorMessage,
  numberValue,
  optionalDbNumber,
  redact,
  requestAuthIdentity,
  requiredDbNumber,
  sha256Hex,
  stringValue,
} from "./utils.js";

export interface UsageContext {
  id: string;
  endpoint: string;
  model?: string;
  stream: boolean;
  startedAt: number;
  clientRequestId?: string;
  clientHash: Promise<string | undefined>;
}

export interface TokenUsage {
  hasCachedTokens: boolean;
  hasReasoningTokens: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

interface UsageRecordInput {
  credential?: SelectedCredential;
  errorCode?: string;
  model?: string;
  response?: JsonValue;
  statusCode: number;
}

interface UsageAggregateDbRow {
  [key: string]: unknown;
  request_count: number | string | bigint | null;
  input_tokens: number | string | bigint | null;
  output_tokens: number | string | bigint | null;
  total_tokens: number | string | bigint | null;
  cached_tokens: number | string | bigint | null;
  reasoning_tokens: number | string | bigint | null;
}

interface UsageHourlyDbRow extends UsageAggregateDbRow {
  hour_start: number | string | bigint;
}

interface UsageModelDbRow extends UsageAggregateDbRow {
  endpoint: string;
  model: string;
}

interface UsageCredentialDbRow extends UsageAggregateDbRow {
  credential_id: string;
}

interface UsageClientDbRow extends UsageAggregateDbRow {
  client_hash: string;
}

interface UsageEventDbRow extends UsageAggregateDbRow {
  id: string;
  created_at: number | string | bigint;
  completed_at: number | string | bigint;
  duration_ms: number | string | bigint;
  endpoint: string;
  model: string | null;
  stream: boolean;
  credential_id: string | null;
  client_hash: string | null;
  client_request_id: string | null;
  upstream_response_id: string | null;
  status_code: number | string | bigint;
  error_code: string | null;
}

interface UsageRange {
  from: number;
  to: number;
}

interface UsageEventsQuery extends UsageRange {
  limit: number;
}

let _ensureSchema: (() => Promise<void>) | undefined;
function ensureSchema(sql: Sql): Promise<void> {
  _ensureSchema ??= lazySingleton(() => createSchema(sql));
  return _ensureSchema();
}

export function createUsageContext(
  request: Request,
  input: { endpoint: string; model?: string; stream: boolean },
): UsageContext {
  const identity = requestAuthIdentity(request);
  return {
    id: crypto.randomUUID(),
    endpoint: input.endpoint,
    model: input.model,
    stream: input.stream,
    startedAt: Date.now(),
    clientRequestId: request.headers.get("x-client-request-id")?.trim() || undefined,
    // 只保留访问方身份的哈希值，避免把代理密钥或 Bearer token 写入数据库。
    clientHash: identity === undefined ? Promise.resolve(undefined) : sha256Hex(identity),
  };
}

export function scheduleUsageRecord(env: AppEnv, context: UsageContext, input: UsageRecordInput): void {
  try {
    const task = usageReporter(env)
      .record(context, input)
      .catch((error) => {
        console.error(`usage record failed: ${normalizeErrorMessage(error)}`);
      });
    waitUntil(task);
  } catch (error) {
    // 用量统计是旁路功能，初始化失败只能写日志，不能改变代理接口的返回结果。
    console.error(`usage record failed: ${normalizeErrorMessage(error)}`);
  }
}

export function usageReporter(env: AppEnv): UsageReporter {
  return new UsageReporter(database(env), env);
}

export function extractTokenUsage(response: JsonValue | undefined): TokenUsage {
  const responseRecord = isRecord(response) ? response : {};
  const usage = isRecord(responseRecord.usage) ? responseRecord.usage : {};
  const inputTokens = numberValue(usage.input_tokens) ?? 0;
  const outputTokens = numberValue(usage.output_tokens) ?? 0;
  const totalTokens = numberValue(usage.total_tokens) ?? inputTokens + outputTokens;
  const cachedTokens = isRecord(usage.input_tokens_details)
    ? numberValue(usage.input_tokens_details.cached_tokens)
    : undefined;
  const reasoningTokens = isRecord(usage.output_tokens_details)
    ? numberValue(usage.output_tokens_details.reasoning_tokens)
    : undefined;
  return {
    hasCachedTokens: cachedTokens !== undefined,
    hasReasoningTokens: reasoningTokens !== undefined,
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens: cachedTokens ?? 0,
    reasoningTokens: reasoningTokens ?? 0,
  };
}

export class UsageReporter {
  private readonly proxyKeyDisplayByHash: Promise<Map<string, string>>;

  constructor(
    private readonly sql: Sql,
    env: AppEnv,
  ) {
    this.proxyKeyDisplayByHash = buildProxyKeyDisplayByHash(env);
  }

  async record(context: UsageContext, input: UsageRecordInput): Promise<void> {
    await ensureSchema(this.sql);
    const completedAt = Date.now();
    const usage = extractTokenUsage(input.response);
    const responseRecord = isRecord(input.response) ? input.response : {};
    const model = input.model ?? context.model ?? stringValue(responseRecord.model);
    const clientHash = await context.clientHash;
    const credentialId = input.credential?.id;
    const hourStart = floorHour(context.startedAt);
    const durationMs = Math.max(0, completedAt - context.startedAt);
    const upstreamResponseId = stringValue(responseRecord.id);

    await this.sql.begin(async (sql) => {
      await sql`
        INSERT INTO usage_events (
          id, created_at, completed_at, duration_ms, endpoint, model, stream,
          credential_id, client_hash, client_request_id, upstream_response_id,
          status_code, error_code, input_tokens, output_tokens, total_tokens,
          cached_tokens, reasoning_tokens
        )
        VALUES (
          ${context.id}, ${context.startedAt}, ${completedAt}, ${durationMs},
          ${context.endpoint}, ${model ?? null}, ${context.stream},
          ${credentialId ?? null}, ${clientHash ?? null}, ${context.clientRequestId ?? null},
          ${upstreamResponseId ?? null}, ${input.statusCode}, ${input.errorCode ?? null},
          ${usage.inputTokens}, ${usage.outputTokens}, ${usage.totalTokens},
          ${usage.cachedTokens}, ${usage.reasoningTokens}
        )
      `;
      await sql`
        INSERT INTO usage_hourly (
          hour_start, endpoint, model, credential_id, client_hash, request_count,
          input_tokens, output_tokens, total_tokens, cached_tokens, reasoning_tokens
        )
        VALUES (
          ${hourStart}, ${context.endpoint}, ${model ?? ""}, ${credentialId ?? ""},
          ${clientHash ?? ""}, 1, ${usage.inputTokens}, ${usage.outputTokens},
          ${usage.totalTokens}, ${usage.cachedTokens}, ${usage.reasoningTokens}
        )
        ON CONFLICT(hour_start, endpoint, model, credential_id, client_hash) DO UPDATE SET
          request_count = usage_hourly.request_count + 1,
          input_tokens = usage_hourly.input_tokens + excluded.input_tokens,
          output_tokens = usage_hourly.output_tokens + excluded.output_tokens,
          total_tokens = usage_hourly.total_tokens + excluded.total_tokens,
          cached_tokens = usage_hourly.cached_tokens + excluded.cached_tokens,
          reasoning_tokens = usage_hourly.reasoning_tokens + excluded.reasoning_tokens
      `;
    });
  }

  async summary(range: UsageRange): Promise<unknown> {
    await ensureSchema(this.sql);
    const from = floorHour(range.from);
    const to = ceilHour(range.to);
    const [totalRows, hourlyRows, modelRows, credentialRows, clientRows, keyDisplayByHash] = await Promise.all([
      this.sql<UsageAggregateDbRow[]>`
        SELECT COALESCE(SUM(request_count), 0) AS request_count,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens,
               COALESCE(SUM(total_tokens), 0) AS total_tokens,
               COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
               COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens
          FROM usage_hourly
         WHERE hour_start >= ${from}
           AND hour_start < ${to}
      `,
      this.sql<UsageHourlyDbRow[]>`
        SELECT hour_start,
               COALESCE(SUM(request_count), 0) AS request_count,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens,
               COALESCE(SUM(total_tokens), 0) AS total_tokens,
               COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
               COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens
          FROM usage_hourly
         WHERE hour_start >= ${from}
           AND hour_start < ${to}
         GROUP BY hour_start
         ORDER BY hour_start ASC
      `,
      this.sql<UsageModelDbRow[]>`
        SELECT endpoint, model,
               COALESCE(SUM(request_count), 0) AS request_count,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens,
               COALESCE(SUM(total_tokens), 0) AS total_tokens,
               COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
               COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens
          FROM usage_hourly
         WHERE hour_start >= ${from}
           AND hour_start < ${to}
         GROUP BY endpoint, model
         ORDER BY total_tokens DESC, request_count DESC
      `,
      this.sql<UsageCredentialDbRow[]>`
        SELECT credential_id,
               COALESCE(SUM(request_count), 0) AS request_count,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens,
               COALESCE(SUM(total_tokens), 0) AS total_tokens,
               COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
               COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens
          FROM usage_hourly
         WHERE hour_start >= ${from}
           AND hour_start < ${to}
         GROUP BY credential_id
         ORDER BY total_tokens DESC, request_count DESC
      `,
      this.sql<UsageClientDbRow[]>`
        SELECT client_hash,
               COALESCE(SUM(request_count), 0) AS request_count,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens,
               COALESCE(SUM(total_tokens), 0) AS total_tokens,
               COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
               COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens
          FROM usage_hourly
         WHERE hour_start >= ${from}
           AND hour_start < ${to}
         GROUP BY client_hash
         ORDER BY total_tokens DESC, request_count DESC
      `,
      this.proxyKeyDisplayByHash,
    ]);

    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      total: aggregateFromRow(totalRows[0]),
      byHour: hourlyRows.map((row) => ({
        hourStart: new Date(requiredDbNumber(row.hour_start, "hour_start")).toISOString(),
        ...aggregateFromRow(row),
      })),
      byModel: modelRows.map((row) => ({
        endpoint: row.endpoint,
        model: row.model || undefined,
        ...aggregateFromRow(row),
      })),
      byCredential: credentialRows.map((row) => ({
        credentialId: row.credential_id || undefined,
        ...aggregateFromRow(row),
      })),
      byClient: clientRows.map((row) => ({
        clientHash: row.client_hash || undefined,
        clientKey: keyDisplayByHash.get(row.client_hash) ?? undefined,
        ...aggregateFromRow(row),
      })),
    };
  }

  async events(query: UsageEventsQuery): Promise<unknown> {
    await ensureSchema(this.sql);
    const [rows, keyDisplayByHash] = await Promise.all([
      this.sql<UsageEventDbRow[]>`
      SELECT id, created_at, completed_at, duration_ms, endpoint, model, stream,
             credential_id, client_hash, client_request_id, upstream_response_id,
             status_code, error_code, input_tokens, output_tokens, total_tokens,
             cached_tokens, reasoning_tokens
        FROM usage_events
       WHERE created_at >= ${query.from}
         AND created_at < ${query.to}
       ORDER BY created_at DESC
       LIMIT ${query.limit}
    `,
      this.proxyKeyDisplayByHash,
    ]);
    return {
      from: new Date(query.from).toISOString(),
      to: new Date(query.to).toISOString(),
      data: rows.map((row) => ({
        id: row.id,
        createdAt: new Date(requiredDbNumber(row.created_at, "created_at")).toISOString(),
        completedAt: new Date(requiredDbNumber(row.completed_at, "completed_at")).toISOString(),
        durationMs: requiredDbNumber(row.duration_ms, "duration_ms"),
        endpoint: row.endpoint,
        model: row.model ?? undefined,
        stream: row.stream,
        credentialId: row.credential_id ?? undefined,
        clientHash: row.client_hash ?? undefined,
        clientKey: row.client_hash ? keyDisplayByHash.get(row.client_hash) : undefined,
        clientRequestId: row.client_request_id ?? undefined,
        upstreamResponseId: row.upstream_response_id ?? undefined,
        statusCode: requiredDbNumber(row.status_code, "status_code"),
        errorCode: row.error_code ?? undefined,
        ...aggregateFromRow(row),
      })),
    };
  }

  async cleanup(retainMs: number): Promise<{ deleted: number }> {
    await ensureSchema(this.sql);
    const cutoff = Date.now() - retainMs;
    const rows = await this.sql<{ deleted: number | string | bigint }[]>`
      WITH deleted AS (
        DELETE FROM usage_events
         WHERE created_at < ${cutoff}
         RETURNING 1
      )
      SELECT COUNT(*) AS deleted FROM deleted
    `;
    return { deleted: optionalDbNumber(rows[0]?.deleted, "deleted") ?? 0 };
  }
}

async function createSchema(sql: Sql): Promise<void> {
  await sql`
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
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_usage_events_created_at
      ON usage_events(created_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_usage_events_model_created_at
      ON usage_events(model, created_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_usage_events_credential_created_at
      ON usage_events(credential_id, created_at DESC)
  `;
  await sql`
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
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_usage_hourly_hour_start
      ON usage_hourly(hour_start DESC)
  `;
}

async function buildProxyKeyDisplayByHash(env: AppEnv): Promise<Map<string, string>> {
  const entries = await Promise.all(
    proxyApiKeys(env).map(async (key, index) => [await sha256Hex(key), `KEY ${index + 1} · ${redact(key)}`] as const),
  );
  return new Map(entries);
}

function aggregateFromRow(row: UsageAggregateDbRow | undefined): Omit<TokenUsage, "hasCachedTokens" | "hasReasoningTokens"> & {
  requestCount: number;
} {
  return {
    requestCount: row === undefined ? 0 : optionalDbNumber(row.request_count, "request_count") ?? 0,
    inputTokens: row === undefined ? 0 : optionalDbNumber(row.input_tokens, "input_tokens") ?? 0,
    outputTokens: row === undefined ? 0 : optionalDbNumber(row.output_tokens, "output_tokens") ?? 0,
    totalTokens: row === undefined ? 0 : optionalDbNumber(row.total_tokens, "total_tokens") ?? 0,
    cachedTokens: row === undefined ? 0 : optionalDbNumber(row.cached_tokens, "cached_tokens") ?? 0,
    reasoningTokens: row === undefined ? 0 : optionalDbNumber(row.reasoning_tokens, "reasoning_tokens") ?? 0,
  };
}

function floorHour(value: number): number {
  return Math.floor(value / 3_600_000) * 3_600_000;
}

function ceilHour(value: number): number {
  return Math.ceil(value / 3_600_000) * 3_600_000;
}
