import { waitUntil } from "@vercel/functions";
import { decryptJson, encryptJson } from "./crypto.js";
import { database, type Sql } from "./db.js";
import { envString, type AppEnv } from "./env.js";
import { parseJwtIdentity } from "./jwt.js";
import {
  fetchCredentialRateLimits,
  isUsageLimitReachedMessage,
  nextResetMillisFromRateLimits,
  normalizeRateLimitSnapshots,
} from "./rate-limits.js";
import type {
  CredentialRefreshSummary,
  CredentialImportResult,
  CredentialStatus,
  PrivateCredential,
  RateLimitSnapshot,
  RefreshSummary,
  ReportResultInput,
  SelectedCredential,
  TokenRefreshResponse,
} from "./types.js";
import {
  booleanValue,
  isRecord,
  isoTime,
  lazySingleton,
  normalizeErrorMessage,
  numberValue,
  optionalDbNumber,
  parseTime,
  requiredDbNumber,
  sha256Hex,
  stringValue,
} from "./utils.js";

const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_DUE_CONCURRENCY = 16;
const RATE_LIMIT_REFRESH_CONCURRENCY = 16;
const DEFAULT_RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS = 60;
const PERMANENT_REFRESH_ERROR_CODES = new Set([
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);

interface CredentialDbRow {
  [key: string]: unknown;
  id: string;
  label: string;
  encrypted_json: string;
  disabled: boolean;
  last_error: string | null;
  created_at: number | string | bigint;
  updated_at: number | string | bigint;
  last_used_at: number | string | bigint | null;
  next_retry_at: number | string | bigint | null;
  refresh_lock_until: number | string | bigint | null;
  rate_limits_json: unknown | null;
  rate_limits_updated_at: number | string | bigint | null;
  success_count: number | string | bigint;
  failure_count: number | string | bigint;
}

interface CredentialRow {
  id: string;
  label: string;
  encryptedJson: string;
  disabled: boolean;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  nextRetryAt?: number;
  refreshLockUntil?: number;
  rateLimits?: RateLimitSnapshot[];
  rateLimitsUpdatedAt?: number;
  successCount: number;
  failureCount: number;
}

interface NormalizedImport {
  id?: string;
  label: string;
  disabled: boolean;
  credential: PrivateCredential;
}

interface RefreshStoreResult {
  credential?: PrivateCredential;
  refreshed: boolean;
}

interface RetryDecision {
  nextRetryAt?: number;
  retryAfterSeconds?: number;
}

type SqlJsonValue = Parameters<Sql["json"]>[0];

class TokenRefreshError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly code?: string,
  ) {
    super(`token refresh failed with HTTP ${status}: ${body}`);
  }

  get permanent(): boolean {
    return this.code !== undefined && PERMANENT_REFRESH_ERROR_CODES.has(this.code);
  }
}

let _ensureSchema: (() => Promise<void>) | undefined;
function ensureSchema(sql: Sql): Promise<void> {
  _ensureSchema ??= lazySingleton(() => createSchema(sql));
  return _ensureSchema();
}

const refreshInflight = new Map<string, Promise<RefreshStoreResult>>();
const rateLimitRefreshInflight = new Map<string, Promise<RateLimitSnapshot[] | undefined>>();
const rateLimitRefreshAttemptedAt = new Map<string, number>();

export function credentialManager(env: AppEnv): CredentialManager {
  return new CredentialManager(database(env), env);
}

export function scheduleCredentialRateLimitUpdate(env: AppEnv, credential: SelectedCredential): void {
  try {
    const task = credentialManager(env)
      .refreshRateLimitsIfStale(credential)
      .catch((error) => {
        console.error(`rate limit refresh failed: ${normalizeErrorMessage(error)}`);
      });
    waitUntil(task);
  } catch (error) {
    console.error(`rate limit refresh failed: ${normalizeErrorMessage(error)}`);
  }
}

export function scheduleCredentialSuccessUpdate(env: AppEnv, id: string, status: number): void {
  try {
    const task = credentialManager(env)
      .reportResult(id, { ok: true, status })
      .catch((error) => {
        console.error(`credential success update failed: ${normalizeErrorMessage(error)}`);
      });
    waitUntil(task);
  } catch (error) {
    console.error(`credential success update failed: ${normalizeErrorMessage(error)}`);
  }
}

async function createSchema(sql: Sql): Promise<void> {
  await sql`
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
    )
  `;
  await sql`ALTER TABLE credentials ADD COLUMN IF NOT EXISTS rate_limits_json JSONB`;
  await sql`ALTER TABLE credentials ADD COLUMN IF NOT EXISTS rate_limits_updated_at BIGINT`;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_credentials_select
      ON credentials(disabled, next_retry_at, refresh_lock_until, last_used_at, created_at)
  `;
}

export class CredentialManager {
  constructor(
    private readonly sql: Sql,
    private readonly env: AppEnv,
  ) {}

  async importCredential(input: unknown): Promise<CredentialImportResult> {
    await ensureSchema(this.sql);
    const normalized = await this.normalizeImport(input);
    const id = normalized.id ?? (await this.defaultCredentialId(normalized.credential));
    const now = Date.now();
    const encrypted = await this.encryptCredential(normalized.credential);
    await this.sql`
      INSERT INTO credentials (
        id, label, encrypted_json, disabled, created_at, updated_at,
        last_used_at, next_retry_at, refresh_lock_until, success_count, failure_count
      )
      VALUES (${id}, ${normalized.label}, ${encrypted}, ${normalized.disabled}, ${now}, ${now}, NULL, NULL, NULL, 0, 0)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        encrypted_json = excluded.encrypted_json,
        disabled = excluded.disabled,
        updated_at = excluded.updated_at,
        last_error = NULL,
        next_retry_at = NULL,
        refresh_lock_until = NULL,
        rate_limits_json = NULL,
        rate_limits_updated_at = NULL
    `;
    return { id, label: normalized.label, disabled: normalized.disabled };
  }

  async listCredentials(): Promise<CredentialStatus[]> {
    await ensureSchema(this.sql);
    const rows = await this.sql<CredentialDbRow[]>`
      SELECT id, label, encrypted_json, disabled, last_error, created_at, updated_at,
             last_used_at, next_retry_at, refresh_lock_until, rate_limits_json, rate_limits_updated_at,
             success_count, failure_count
        FROM credentials
       ORDER BY created_at ASC
    `;
    const out: CredentialStatus[] = [];
    for (const row of rows) {
      const normalized = normalizeRow(row);
      const credential = await this.decryptCredential(normalized.encryptedJson);
      out.push(this.statusFromRow(normalized, credential));
    }
    return out;
  }

  async selectCredential(excludedIds: string[] = []): Promise<SelectedCredential | null> {
    await ensureSchema(this.sql);
    const now = Date.now();
    const exclude = [...new Set(excludedIds)];
    for (;;) {
      const dbRows = await this.claimCredentialCandidate(now, exclude);
      if (dbRows.length === 0) {
        return null;
      }
      const row = normalizeRow(dbRows[0]);
      try {
        let credential = await this.decryptCredential(row.encryptedJson);
        if (this.shouldRefresh(credential, true)) {
          const result = await this.refreshAndStore(row, credential, { force: false, enforceMinInterval: true });
          if (!result.credential) {
            continue;
          }
          credential = result.credential;
        }
        const token = credential.accessToken;
        if (!token) {
          throw new Error("credential has no usable token");
        }
        return {
          id: row.id,
          label: row.label,
          token,
          accountId: credential.accountId,
        };
      } catch (error) {
        exclude.push(row.id);
        if (!isPermanentRefreshFailure(error)) {
          await this.markFailure(row.id, 0, normalizeErrorMessage(error), {
            retryAfterSeconds: this.failureCooldownSeconds(),
          });
        }
      }
    }
  }

  async reportResult(id: string, input: ReportResultInput): Promise<void> {
    await ensureSchema(this.sql);
    const now = Date.now();
    if (input.rateLimits !== undefined) {
      await this.storeRateLimits(id, input.rateLimits, now);
    }
    if (input.ok) {
      await this.sql`
        UPDATE credentials
           SET success_count = success_count + 1,
               last_error = CASE
                 WHEN next_retry_at IS NULL OR next_retry_at <= ${now} THEN NULL
                 ELSE last_error
               END,
               next_retry_at = CASE
                 WHEN next_retry_at IS NULL OR next_retry_at <= ${now} THEN NULL
                 ELSE next_retry_at
               END,
               updated_at = ${now}
         WHERE id = ${id}
      `;
      return;
    }

    const retry = this.retryForResult(input);
    await this.markFailure(id, input.status, input.message ?? `upstream returned HTTP ${input.status}`, retry);
  }

  async refreshRateLimits(credential: SelectedCredential): Promise<RateLimitSnapshot[]> {
    await ensureSchema(this.sql);
    const snapshots = await fetchCredentialRateLimits(this.env, credential);
    await this.storeRateLimits(credential.id, snapshots);
    return snapshots;
  }

  async refreshRateLimitsIfStale(credential: SelectedCredential): Promise<RateLimitSnapshot[] | undefined> {
    await ensureSchema(this.sql);
    const now = Date.now();
    const minIntervalMs = this.rateLimitRefreshMinIntervalSeconds() * 1000;
    const lastAttemptedAt = rateLimitRefreshAttemptedAt.get(credential.id);
    if (lastAttemptedAt !== undefined && now - lastAttemptedAt < minIntervalMs) {
      return undefined;
    }
    const existing = rateLimitRefreshInflight.get(credential.id);
    if (existing) {
      return existing;
    }
    rateLimitRefreshAttemptedAt.set(credential.id, now);
    const task = this.refreshRateLimitsIfStaleInner(credential, now, minIntervalMs).finally(() => {
      rateLimitRefreshInflight.delete(credential.id);
    });
    rateLimitRefreshInflight.set(credential.id, task);
    return task;
  }

  async setEnabled(id: string, enabled: boolean): Promise<CredentialStatus> {
    await ensureSchema(this.sql);
    const now = Date.now();
    await this.sql`
      UPDATE credentials
         SET disabled = ${!enabled},
             updated_at = ${now},
             next_retry_at = NULL,
             refresh_lock_until = NULL
       WHERE id = ${id}
    `;
    const row = await this.rowById(id);
    if (!row) {
      throw new Error("credential not found");
    }
    return this.statusFromRow(row, await this.decryptCredential(row.encryptedJson));
  }

  async deleteCredential(id: string): Promise<{ deleted: boolean }> {
    await ensureSchema(this.sql);
    await this.sql`DELETE FROM credentials WHERE id = ${id}`;
    return { deleted: true };
  }

  async refreshCredential(id: string): Promise<CredentialStatus> {
    await ensureSchema(this.sql);
    const row = await this.rowById(id);
    if (!row) {
      throw new Error("credential not found");
    }
    const credential = await this.decryptCredential(row.encryptedJson);
    const result = await this.refreshAndStore(row, credential, { force: true, enforceMinInterval: false });
    if (!result.credential) {
      throw new Error("credential refresh is already in progress");
    }
    return this.statusFromRow((await this.rowById(id)) ?? row, result.credential);
  }

  async refreshCredentials(): Promise<CredentialRefreshSummary> {
    const tokenRefresh = await this.refreshDue();
    const rateLimits = await this.refreshAllRateLimits();
    return { ...tokenRefresh, rateLimits };
  }

  async refreshDue(): Promise<RefreshSummary> {
    await ensureSchema(this.sql);
    const dbRows = await this.sql<CredentialDbRow[]>`
      SELECT id, label, encrypted_json, disabled, last_error, created_at, updated_at,
             last_used_at, next_retry_at, refresh_lock_until, rate_limits_json, rate_limits_updated_at,
             success_count, failure_count
        FROM credentials
       WHERE disabled = FALSE
       ORDER BY created_at ASC
    `;
    const rows = dbRows.map(normalizeRow);
    const results = await mapWithConcurrency(rows, REFRESH_DUE_CONCURRENCY, async (row) => {
      try {
        const credential = await this.decryptCredential(row.encryptedJson);
        if (!this.shouldRefresh(credential, false)) {
          return { refreshed: 0, failed: 0 };
        }
        const result = await this.refreshAndStore(row, credential, { force: false, enforceMinInterval: false });
        return { refreshed: result.refreshed ? 1 : 0, failed: 0 };
      } catch (error) {
        if (!isPermanentRefreshFailure(error)) {
          await this.markFailure(row.id, 0, normalizeErrorMessage(error), {
            retryAfterSeconds: this.failureCooldownSeconds(),
          });
        }
        return { refreshed: 0, failed: 1 };
      }
    });
    return results.reduce<RefreshSummary>(
      (summary, result) => ({
        checked: summary.checked,
        refreshed: summary.refreshed + result.refreshed,
        failed: summary.failed + result.failed,
      }),
      { checked: rows.length, refreshed: 0, failed: 0 },
    );
  }

  private async refreshAllRateLimits(): Promise<RefreshSummary> {
    await ensureSchema(this.sql);
    const dbRows = await this.sql<CredentialDbRow[]>`
      SELECT id, label, encrypted_json, disabled, last_error, created_at, updated_at,
             last_used_at, next_retry_at, refresh_lock_until, rate_limits_json, rate_limits_updated_at,
             success_count, failure_count
        FROM credentials
       WHERE disabled = FALSE
       ORDER BY created_at ASC
    `;
    const rows = dbRows.map(normalizeRow);
    const results = await mapWithConcurrency(rows, RATE_LIMIT_REFRESH_CONCURRENCY, async (row) => {
      try {
        const credential = await this.decryptCredential(row.encryptedJson);
        const token = credential.accessToken;
        if (!token) {
          throw new Error("credential has no usable token");
        }
        await this.refreshRateLimits({
          id: row.id,
          label: row.label,
          token,
          accountId: credential.accountId,
        });
        return { refreshed: 1, failed: 0 };
      } catch (error) {
        console.error(`credential rate limit refresh failed for ${row.id}: ${normalizeErrorMessage(error)}`);
        return { refreshed: 0, failed: 1 };
      }
    });
    return results.reduce<RefreshSummary>(
      (summary, result) => ({
        checked: summary.checked,
        refreshed: summary.refreshed + result.refreshed,
        failed: summary.failed + result.failed,
      }),
      { checked: rows.length, refreshed: 0, failed: 0 },
    );
  }

  private async rowById(id: string): Promise<CredentialRow | undefined> {
    const rows = await this.sql<CredentialDbRow[]>`
      SELECT id, label, encrypted_json, disabled, last_error, created_at, updated_at,
             last_used_at, next_retry_at, refresh_lock_until, rate_limits_json, rate_limits_updated_at,
             success_count, failure_count
        FROM credentials
       WHERE id = ${id}
    `;
    return rows[0] ? normalizeRow(rows[0]) : undefined;
  }

  private async claimCredentialCandidate(now: number, excludedIds: string[]): Promise<CredentialDbRow[]> {
    if (excludedIds.length === 0) {
      return this.sql<CredentialDbRow[]>`
        WITH candidate AS (
          SELECT id
            FROM credentials
           WHERE disabled = FALSE
             AND (next_retry_at IS NULL OR next_retry_at <= ${now})
             AND (refresh_lock_until IS NULL OR refresh_lock_until <= ${now})
           ORDER BY COALESCE(last_used_at, 0) ASC, failure_count ASC, created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        UPDATE credentials
           SET last_used_at = ${now},
               updated_at = ${now},
               last_error = NULL
         WHERE id = (SELECT id FROM candidate)
         RETURNING id, label, encrypted_json, disabled, last_error, created_at, updated_at,
                   last_used_at, next_retry_at, refresh_lock_until, rate_limits_json, rate_limits_updated_at,
                   success_count, failure_count
      `;
    }
    return this.sql<CredentialDbRow[]>`
      WITH candidate AS (
        SELECT id
          FROM credentials
         WHERE disabled = FALSE
           AND (next_retry_at IS NULL OR next_retry_at <= ${now})
           AND (refresh_lock_until IS NULL OR refresh_lock_until <= ${now})
           AND id NOT IN ${this.sql(excludedIds)}
         ORDER BY COALESCE(last_used_at, 0) ASC, failure_count ASC, created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      UPDATE credentials
         SET last_used_at = ${now},
             updated_at = ${now},
             last_error = NULL
       WHERE id = (SELECT id FROM candidate)
       RETURNING id, label, encrypted_json, disabled, last_error, created_at, updated_at,
                 last_used_at, next_retry_at, refresh_lock_until, rate_limits_json, rate_limits_updated_at,
                 success_count, failure_count
    `;
  }

  private async refreshRateLimitsIfStaleInner(
    credential: SelectedCredential,
    now: number,
    minIntervalMs: number,
  ): Promise<RateLimitSnapshot[] | undefined> {
    const rows = await this.sql<{ rate_limits_updated_at: number | string | bigint | null }[]>`
      SELECT rate_limits_updated_at
        FROM credentials
       WHERE id = ${credential.id}
    `;
    const updatedAt = optionalDbNumber(rows[0]?.rate_limits_updated_at, "rate_limits_updated_at");
    if (updatedAt !== undefined && now - updatedAt < minIntervalMs) {
      return undefined;
    }
    return this.refreshRateLimits(credential);
  }

  private async normalizeImport(input: unknown): Promise<NormalizedImport> {
    if (!isRecord(input)) {
      throw new Error("credential import payload must be an object");
    }

    const accessToken = requiredImportString(input, "access_token");
    const refreshToken = requiredImportString(input, "refresh_token");
    const idToken = requiredImportString(input, "id_token");
    const accountId = requiredImportString(input, "account_id");
    const email = requiredImportString(input, "email");
    const expiresAt = requiredImportString(input, "expired");
    const lastRefresh = requiredImportString(input, "last_refresh");
    const tokenType = requiredImportString(input, "type");
    const label = email || accountId || "codex";
    const disabled = booleanValue(input.disabled) ?? false;

    return {
      label,
      disabled,
      credential: {
        accessToken,
        refreshToken,
        idToken,
        tokenType,
        accountId,
        email,
        expiresAt,
        lastRefresh,
      },
    };
  }

  private async defaultCredentialId(credential: PrivateCredential): Promise<string> {
    const seed = credential.email ?? credential.accountId ?? credential.refreshToken;
    if (!seed) {
      throw new Error("credential must include email, account_id, or refresh_token");
    }
    return `codex-${(await sha256Hex(seed)).slice(0, 20)}`;
  }

  private statusFromRow(row: CredentialRow, credential: PrivateCredential): CredentialStatus {
    const now = Date.now();
    const expiresAt = parseTime(credential.expiresAt);
    let status: CredentialStatus["status"] = "available";
    if (row.disabled) {
      status = "disabled";
    } else if (!credential.refreshToken && !credential.accessToken) {
      status = "invalid";
    } else if (row.nextRetryAt !== undefined && row.nextRetryAt > now) {
      status = "cooldown";
    } else if (expiresAt !== undefined && expiresAt <= now) {
      status = "expired";
    } else if (this.shouldRefresh(credential, false)) {
      status = "refresh_due";
    }
    return {
      id: row.id,
      label: row.label,
      enabled: !row.disabled,
      status,
      accountId: credential.accountId,
      email: credential.email,
      expiresAt: credential.expiresAt,
      lastRefresh: credential.lastRefresh,
      nextRetryAt: isoTime(row.nextRetryAt),
      lastError: row.lastError,
      rateLimits: row.rateLimits,
      rateLimitsUpdatedAt: isoTime(row.rateLimitsUpdatedAt),
      successCount: row.successCount,
      failureCount: row.failureCount,
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  private shouldRefresh(credential: PrivateCredential, enforceExpired: boolean): boolean {
    if (!credential.accessToken && credential.refreshToken) {
      return true;
    }
    const expiresAt = parseTime(credential.expiresAt);
    if (expiresAt === undefined) {
      return false;
    }
    const now = Date.now();
    if (expiresAt <= now) {
      return credential.refreshToken !== undefined;
    }
    if (enforceExpired) {
      const lastRefresh = parseTime(credential.lastRefresh);
      if (lastRefresh !== undefined && now - lastRefresh < this.refreshMinIntervalSeconds() * 1000) {
        return false;
      }
    }
    return expiresAt - now <= this.refreshLeadSeconds() * 1000 && credential.refreshToken !== undefined;
  }

  private async refreshAndStore(
    row: CredentialRow,
    credential: PrivateCredential,
    options: { force: boolean; enforceMinInterval: boolean },
  ): Promise<RefreshStoreResult> {
    const existing = refreshInflight.get(row.id);
    if (existing) {
      return existing;
    }
    const refresh = this.refreshAndStoreInner(row, credential, options).finally(() => {
      refreshInflight.delete(row.id);
    });
    refreshInflight.set(row.id, refresh);
    return refresh;
  }

  private async refreshAndStoreInner(
    row: CredentialRow,
    credential: PrivateCredential,
    options: { force: boolean; enforceMinInterval: boolean },
  ): Promise<RefreshStoreResult> {
    if (!credential.refreshToken) {
      throw new Error("credential has no refresh token");
    }
    const now = Date.now();
    const lockUntil = now + this.refreshLockSeconds() * 1000;
    const locked = await this.sql<CredentialDbRow[]>`
      UPDATE credentials
         SET refresh_lock_until = ${lockUntil},
             updated_at = ${now}
       WHERE id = ${row.id}
         AND (refresh_lock_until IS NULL OR refresh_lock_until <= ${now})
       RETURNING id, label, encrypted_json, disabled, last_error, created_at, updated_at,
                 last_used_at, next_retry_at, refresh_lock_until, rate_limits_json, rate_limits_updated_at,
                 success_count, failure_count
    `;
    if (locked.length === 0) {
      return { refreshed: false };
    }
    try {
      const lockedRow = normalizeRow(locked[0]);
      const current = await this.decryptCredential(lockedRow.encryptedJson);
      if (!current.refreshToken) {
        throw new Error("credential has no refresh token");
      }
      if (!options.force && !this.shouldRefresh(current, options.enforceMinInterval)) {
        await this.sql`
          UPDATE credentials
             SET refresh_lock_until = NULL,
                 updated_at = ${Date.now()}
           WHERE id = ${row.id}
        `;
        return { credential: current, refreshed: false };
      }
      const refreshed = await this.refreshWithOpenAI(current.refreshToken);
      const identity = parseJwtIdentity(refreshed.id_token);
      const refreshedAt = Date.now();
      const next: PrivateCredential = {
        ...current,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        idToken: refreshed.id_token ?? current.idToken,
        tokenType: refreshed.token_type ?? current.tokenType,
        accountId: identity.accountId ?? current.accountId,
        email: identity.email ?? current.email,
        expiresAt:
          refreshed.expires_in !== undefined
            ? new Date(refreshedAt + refreshed.expires_in * 1000).toISOString()
            : identity.expiresAt ?? current.expiresAt,
        lastRefresh: new Date(refreshedAt).toISOString(),
      };
      await this.sql`
        UPDATE credentials
           SET encrypted_json = ${await this.encryptCredential(next)},
               last_error = NULL,
               next_retry_at = NULL,
               refresh_lock_until = NULL,
               updated_at = ${refreshedAt}
         WHERE id = ${row.id}
      `;
      return { credential: next, refreshed: true };
    } catch (error) {
      if (isPermanentRefreshFailure(error)) {
        await this.markPermanentRefreshFailure(row.id, normalizeErrorMessage(error));
      } else {
        await this.sql`UPDATE credentials SET refresh_lock_until = NULL, updated_at = ${Date.now()} WHERE id = ${row.id}`;
      }
      throw error;
    }
  }

  private async refreshWithOpenAI(refreshToken: string): Promise<TokenRefreshResponse> {
    const response = await fetch(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new TokenRefreshError(response.status, body, parseRefreshErrorCode(body));
    }
    const value: unknown = JSON.parse(body);
    if (!isRecord(value) || typeof value.access_token !== "string") {
      throw new Error("token refresh response did not include access_token");
    }
    const newRefreshToken = stringValue(value.refresh_token);
    if (!newRefreshToken) {
      throw new Error("token refresh response did not include refresh_token");
    }
    return {
      access_token: value.access_token,
      refresh_token: newRefreshToken,
      id_token: stringValue(value.id_token),
      token_type: stringValue(value.token_type),
      expires_in: numberValue(value.expires_in),
    };
  }

  private async markPermanentRefreshFailure(id: string, message: string): Promise<void> {
    const now = Date.now();
    await this.sql`
      UPDATE credentials
         SET disabled = TRUE,
             failure_count = failure_count + 1,
             last_error = ${message},
             next_retry_at = NULL,
             refresh_lock_until = NULL,
             updated_at = ${now}
       WHERE id = ${id}
    `;
  }

  private async markFailure(id: string, status: number, message: string, retry: RetryDecision): Promise<void> {
    const now = Date.now();
    const nextRetryAt = retry.nextRetryAt ?? now + Math.max(1, retry.retryAfterSeconds ?? 0) * 1000;
    await this.sql`
      UPDATE credentials
         SET failure_count = failure_count + 1,
             last_error = ${status > 0 ? `HTTP ${status}: ${message}` : message},
             next_retry_at = ${nextRetryAt},
             refresh_lock_until = NULL,
             updated_at = ${now}
       WHERE id = ${id}
    `;
  }

  private retryAfterForStatus(status: number): number {
    if (status === 401 || status === 403) {
      return this.failureCooldownSeconds();
    }
    if (status === 429) {
      return this.failureCooldownSeconds();
    }
    if (status >= 500) {
      return Math.min(60, this.failureCooldownSeconds());
    }
    return 0;
  }

  private retryForResult(input: ReportResultInput): RetryDecision {
    if (input.status === 429 && isUsageLimitReachedMessage(input.message)) {
      const nextRetryAt = nextResetMillisFromRateLimits(input.rateLimits);
      if (nextRetryAt !== undefined) {
        return { nextRetryAt };
      }
    }
    return { retryAfterSeconds: input.retryAfterSeconds ?? this.retryAfterForStatus(input.status) };
  }

  private async storeRateLimits(id: string, snapshots: RateLimitSnapshot[], updatedAt = Date.now()): Promise<void> {
    await this.sql`
      UPDATE credentials
         SET rate_limits_json = ${this.sql.json(snapshots as unknown as SqlJsonValue)},
             rate_limits_updated_at = ${updatedAt},
             updated_at = ${updatedAt}
       WHERE id = ${id}
    `;
  }

  private async encryptCredential(credential: PrivateCredential): Promise<string> {
    return encryptJson(this.encryptionSecret(), credential);
  }

  private async decryptCredential(encrypted: string): Promise<PrivateCredential> {
    return decryptJson<PrivateCredential>(this.encryptionSecret(), encrypted);
  }

  private encryptionSecret(): string {
    const secret = envString(this.env, "CRED_ENCRYPTION_KEY");
    if (!secret) {
      throw new Error("CRED_ENCRYPTION_KEY secret is required");
    }
    return secret;
  }

  private refreshLeadSeconds(): number {
    return numberValue(this.env.REFRESH_LEAD_SECONDS) ?? 2 * 24 * 60 * 60;
  }

  private refreshMinIntervalSeconds(): number {
    return numberValue(this.env.REFRESH_MIN_INTERVAL_SECONDS) ?? 300;
  }

  private failureCooldownSeconds(): number {
    return numberValue(this.env.FAILURE_COOLDOWN_SECONDS) ?? 300;
  }

  private refreshLockSeconds(): number {
    return numberValue(this.env.REFRESH_LOCK_SECONDS) ?? 120;
  }

  private rateLimitRefreshMinIntervalSeconds(): number {
    return (
      numberValue(this.env.RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS) ??
      DEFAULT_RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS
    );
  }
}

function normalizeRow(row: CredentialDbRow): CredentialRow {
  return {
    id: row.id,
    label: row.label,
    encryptedJson: row.encrypted_json,
    disabled: row.disabled,
    lastError: row.last_error ?? undefined,
    createdAt: requiredDbNumber(row.created_at, "created_at"),
    updatedAt: requiredDbNumber(row.updated_at, "updated_at"),
    lastUsedAt: optionalDbNumber(row.last_used_at, "last_used_at"),
    nextRetryAt: optionalDbNumber(row.next_retry_at, "next_retry_at"),
    refreshLockUntil: optionalDbNumber(row.refresh_lock_until, "refresh_lock_until"),
    rateLimits: normalizeRateLimitSnapshots(row.rate_limits_json),
    rateLimitsUpdatedAt: optionalDbNumber(row.rate_limits_updated_at, "rate_limits_updated_at"),
    successCount: requiredDbNumber(row.success_count, "success_count"),
    failureCount: requiredDbNumber(row.failure_count, "failure_count"),
  };
}

function isPermanentRefreshFailure(error: unknown): error is TokenRefreshError {
  return error instanceof TokenRefreshError && error.permanent;
}

function parseRefreshErrorCode(body: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const error = value.error;
  if (typeof error === "string") {
    return error.toLowerCase();
  }
  if (isRecord(error)) {
    return stringValue(error.code)?.toLowerCase();
  }
  return stringValue(value.code)?.toLowerCase();
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function requiredImportString(input: Record<string, unknown>, field: string): string {
  const value = stringValue(input[field]);
  if (value === undefined) {
    throw new Error(`credential JSON must include ${field}`);
  }
  return value;
}
