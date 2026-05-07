import { database, type Sql } from "./db.js";
import { envString, proxyApiKeys, type AppEnv } from "./env.js";
import { isRecord, isoTime, lazySingleton, redact, requiredDbNumber, sha256Hex, stringValue } from "./utils.js";

export interface KeyDisplay {
  display: string;
  id?: string;
}

export interface ProxySettings {
  adminToken?: KeyDisplay;
  fastMode: boolean;
  identityConfuse: boolean;
  proxyApiKeys: KeyDisplay[];
  serviceTier: "priority" | "default";
  updatedAt?: string;
}

export interface AuthSettings {
  adminTokenHash?: string;
  proxyApiKeyHashes: string[];
}

const DEFAULT_FAST_MODE = true;
const DEFAULT_IDENTITY_CONFUSE = false;
const FAST_MODE_SERVICE_TIER = "priority";
const DEFAULT_SERVICE_TIER = "default";

interface SettingsDbRow {
  [key: string]: unknown;
  admin_token_display: string | null;
  admin_token_hash: string | null;
  fast_mode: boolean;
  identity_confuse: boolean | null;
  proxy_api_key_hashes_json: unknown | null;
  updated_at: number | string | bigint;
}

interface KeyFingerprint extends KeyDisplay {
  hash: string;
  id: string;
}

interface SettingsUpdate {
  adminToken?: string;
  fastMode?: boolean;
  identityConfuse?: boolean;
  proxyApiKeys?: ProxyApiKeyUpdate;
}

type ProxyApiKeyUpdate = string | ProxyApiKeyUpdateItem[];

interface ProxyApiKeyUpdateItem {
  id?: string;
  value?: string;
}

type SqlJsonValue = Parameters<Sql["json"]>[0];

let _ensureSchema: (() => Promise<void>) | undefined;
function ensureSchema(sql: Sql, env: AppEnv): Promise<void> {
  _ensureSchema ??= lazySingleton(() => createSchema(sql, env));
  return _ensureSchema();
}

export function settingsStore(env: AppEnv): SettingsStore {
  return new SettingsStore(database(env), env);
}

export class SettingsStore {
  constructor(
    private readonly sql: Sql,
    private readonly env: AppEnv,
  ) {}

  async getSettings(): Promise<ProxySettings> {
    await ensureSchema(this.sql, this.env);
    const rows = await this.sql<SettingsDbRow[]>`
      SELECT fast_mode, identity_confuse, proxy_api_key_hashes_json, admin_token_hash, admin_token_display, updated_at
        FROM proxy_settings
       WHERE id = 1
    `;
    return settingsFromRow(rows[0]);
  }

  async getAuthSettings(): Promise<AuthSettings> {
    await ensureSchema(this.sql, this.env);
    const rows = await this.sql<SettingsDbRow[]>`
      SELECT fast_mode, identity_confuse, proxy_api_key_hashes_json, admin_token_hash, admin_token_display, updated_at
        FROM proxy_settings
       WHERE id = 1
    `;
    const row = rows[0];
    return {
      adminTokenHash: stringValue(row?.admin_token_hash),
      proxyApiKeyHashes: keyFingerprintsFromJson(row?.proxy_api_key_hashes_json).map((item) => item.hash),
    };
  }

  async proxyKeyDisplayByHash(): Promise<Map<string, string>> {
    await ensureSchema(this.sql, this.env);
    const rows = await this.sql<SettingsDbRow[]>`
      SELECT fast_mode, identity_confuse, proxy_api_key_hashes_json, admin_token_hash, admin_token_display, updated_at
        FROM proxy_settings
       WHERE id = 1
    `;
    return new Map(keyFingerprintsFromJson(rows[0]?.proxy_api_key_hashes_json).map((item) => [item.hash, item.display]));
  }

  async updateSettings(input: unknown): Promise<ProxySettings> {
    const update = normalizeSettingsUpdate(input);
    await ensureSchema(this.sql, this.env);
    const now = Date.now();
    const existing = await this.getSettingsRow();
    const existingProxyApiKeys = keyFingerprintsFromJson(existing?.proxy_api_key_hashes_json);
    const proxyApiKeys = update.proxyApiKeys === undefined
      ? existingProxyApiKeys
      : await resolveProxyApiKeyUpdate(update.proxyApiKeys, existingProxyApiKeys);
    const adminToken = update.adminToken === undefined || update.adminToken.trim() === ""
      ? keyFingerprintFromRow(existing)
      : await keyFingerprint(update.adminToken, "ADMIN");
    const rows = await this.sql<SettingsDbRow[]>`
      INSERT INTO proxy_settings (
        id, fast_mode, identity_confuse, proxy_api_key_hashes_json, admin_token_hash, admin_token_display, updated_at
      )
      VALUES (
        1, ${update.fastMode ?? existing?.fast_mode ?? DEFAULT_FAST_MODE},
        ${update.identityConfuse ?? existing?.identity_confuse ?? DEFAULT_IDENTITY_CONFUSE},
        ${this.sql.json(proxyApiKeys as unknown as SqlJsonValue)},
        ${adminToken?.hash ?? null}, ${adminToken?.display ?? null}, ${now}
      )
      ON CONFLICT(id) DO UPDATE SET
        fast_mode = excluded.fast_mode,
        identity_confuse = excluded.identity_confuse,
        proxy_api_key_hashes_json = excluded.proxy_api_key_hashes_json,
        admin_token_hash = excluded.admin_token_hash,
        admin_token_display = excluded.admin_token_display,
        updated_at = excluded.updated_at
       RETURNING fast_mode, identity_confuse, updated_at
    `;
    return {
      ...settingsFromRow({
        ...rows[0],
        proxy_api_key_hashes_json: proxyApiKeys,
        admin_token_hash: adminToken?.hash ?? null,
        admin_token_display: adminToken?.display ?? null,
      }),
      updatedAt: isoTime(now),
    };
  }

  private async getSettingsRow(): Promise<SettingsDbRow | undefined> {
    const rows = await this.sql<SettingsDbRow[]>`
      SELECT fast_mode, identity_confuse, proxy_api_key_hashes_json, admin_token_hash, admin_token_display, updated_at
        FROM proxy_settings
       WHERE id = 1
    `;
    return rows[0];
  }
}

async function createSchema(sql: Sql, env: AppEnv): Promise<void> {
  const now = Date.now();
  const envProxyKeys = await keyFingerprints(proxyApiKeys(env));
  const envAdminToken = envString(env, "ADMIN_TOKEN");
  const envAdmin = envAdminToken === undefined ? undefined : await keyFingerprint(envAdminToken, "ADMIN");
  await sql`
    CREATE TABLE IF NOT EXISTS proxy_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      fast_mode BOOLEAN NOT NULL DEFAULT TRUE,
      identity_confuse BOOLEAN NOT NULL DEFAULT FALSE,
      proxy_api_key_hashes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      admin_token_hash TEXT,
      admin_token_display TEXT,
      updated_at BIGINT NOT NULL
    )
  `;
  await sql`ALTER TABLE proxy_settings ADD COLUMN IF NOT EXISTS identity_confuse BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE proxy_settings ADD COLUMN IF NOT EXISTS proxy_api_key_hashes_json JSONB NOT NULL DEFAULT '[]'::jsonb`;
  await sql`ALTER TABLE proxy_settings ADD COLUMN IF NOT EXISTS admin_token_hash TEXT`;
  await sql`ALTER TABLE proxy_settings ADD COLUMN IF NOT EXISTS admin_token_display TEXT`;
  await sql`
    INSERT INTO proxy_settings (
      id, fast_mode, identity_confuse, proxy_api_key_hashes_json, admin_token_hash, admin_token_display, updated_at
    )
    VALUES (
      1, ${DEFAULT_FAST_MODE}, ${DEFAULT_IDENTITY_CONFUSE}, ${sql.json(envProxyKeys as unknown as SqlJsonValue)},
      ${envAdmin?.hash ?? null}, ${envAdmin?.display ?? null}, ${now}
    )
    ON CONFLICT(id) DO NOTHING
  `;
  await seedMissingAuthSettings(sql, envProxyKeys, envAdmin, now);
}

function settingsFromRow(row: SettingsDbRow | undefined): ProxySettings {
  const fastMode = row?.fast_mode ?? DEFAULT_FAST_MODE;
  const identityConfuse = row?.identity_confuse ?? DEFAULT_IDENTITY_CONFUSE;
  const updatedAt = row === undefined ? undefined : isoTime(requiredDbNumber(row.updated_at, "updated_at"));
  const adminToken = keyFingerprintFromRow(row);
  return {
    adminToken: adminToken === undefined ? undefined : { display: adminToken.display },
    fastMode,
    identityConfuse,
    proxyApiKeys: keyFingerprintsFromJson(row?.proxy_api_key_hashes_json).map(({ display, id }) => ({ display, id })),
    serviceTier: fastMode ? FAST_MODE_SERVICE_TIER : DEFAULT_SERVICE_TIER,
    updatedAt,
  };
}

async function seedMissingAuthSettings(
  sql: Sql,
  envProxyKeys: KeyFingerprint[],
  envAdmin: KeyFingerprint | undefined,
  now: number,
): Promise<void> {
  const rows = await sql<SettingsDbRow[]>`
    SELECT fast_mode, proxy_api_key_hashes_json, admin_token_hash, admin_token_display, updated_at
      FROM proxy_settings
     WHERE id = 1
  `;
  const row = rows[0];
  if (!row) {
    return;
  }
  if (keyFingerprintsFromJson(row.proxy_api_key_hashes_json).length === 0 && envProxyKeys.length > 0) {
    await sql`
      UPDATE proxy_settings
         SET proxy_api_key_hashes_json = ${sql.json(envProxyKeys as unknown as SqlJsonValue)},
             updated_at = ${now}
       WHERE id = 1
    `;
  }
  if (stringValue(row.admin_token_hash) === undefined && envAdmin !== undefined) {
    await sql`
      UPDATE proxy_settings
         SET admin_token_hash = ${envAdmin.hash},
             admin_token_display = ${envAdmin.display},
             updated_at = ${now}
       WHERE id = 1
    `;
  }
}

function normalizeSettingsUpdate(value: unknown): SettingsUpdate {
  if (!isRecord(value)) {
    throw new Error("settings payload must be an object");
  }
  const out: SettingsUpdate = {};
  if ("fastMode" in value) {
    if (typeof value.fastMode !== "boolean") {
      throw new Error("fastMode must be boolean");
    }
    out.fastMode = value.fastMode;
  }
  if ("identityConfuse" in value) {
    if (typeof value.identityConfuse !== "boolean") {
      throw new Error("identityConfuse must be boolean");
    }
    out.identityConfuse = value.identityConfuse;
  }
  if ("proxyApiKeys" in value) {
    if (typeof value.proxyApiKeys === "string") {
      out.proxyApiKeys = value.proxyApiKeys;
    } else if (Array.isArray(value.proxyApiKeys)) {
      out.proxyApiKeys = value.proxyApiKeys.map((item) => normalizeProxyApiKeyUpdateItem(item));
    } else {
      throw new Error("proxyApiKeys must be a string or array");
    }
  }
  if ("adminToken" in value) {
    if (typeof value.adminToken !== "string") {
      throw new Error("adminToken must be a string");
    }
    out.adminToken = value.adminToken;
  }
  return out;
}

function normalizeProxyApiKeyUpdateItem(value: unknown): ProxyApiKeyUpdateItem {
  if (!isRecord(value)) {
    throw new Error("proxyApiKeys entries must be objects");
  }
  const id = stringValue(value.id);
  const rawValue = value.value;
  if (rawValue !== undefined && typeof rawValue !== "string") {
    throw new Error("proxyApiKeys entry value must be a string");
  }
  const secretValue = stringValue(rawValue);
  if (id === undefined && secretValue === undefined) {
    throw new Error("proxyApiKeys entries must include id or value");
  }
  return {
    ...(id === undefined ? {} : { id }),
    ...(secretValue === undefined ? {} : { value: secretValue }),
  };
}

function parseKeyList(value: string, field: string): string[] {
  const keys = [...new Set(value.split(/[,\n]+/).map((key) => key.trim()).filter((key) => key !== ""))];
  if (keys.length === 0) {
    throw new Error(`${field} must include at least one key`);
  }
  return keys;
}

async function keyFingerprints(keys: string[]): Promise<KeyFingerprint[]> {
  const items = await Promise.all(keys.map(async (key) => {
    const hash = await sha256Hex(key);
    return {
      hash,
      id: keyId(hash),
      display: redact(key),
    };
  }));
  return relabelProxyKeys(items);
}

async function keyFingerprint(key: string, label: string): Promise<KeyFingerprint> {
  const trimmed = key.trim();
  if (trimmed === "") {
    throw new Error(`${label} key must be non-empty`);
  }
  const hash = await sha256Hex(trimmed);
  return {
    hash,
    id: keyId(hash),
    display: `${label} · ${redact(trimmed)}`,
  };
}

function keyFingerprintFromRow(row: SettingsDbRow | undefined): KeyFingerprint | undefined {
  const hash = stringValue(row?.admin_token_hash);
  const display = stringValue(row?.admin_token_display);
  return hash === undefined || display === undefined ? undefined : { hash, display, id: keyId(hash) };
}

function keyFingerprintsFromJson(value: unknown): KeyFingerprint[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("database field proxy_api_key_hashes_json must be an array");
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error("database field proxy_api_key_hashes_json must contain objects");
    }
    const hash = stringValue(item.hash);
    const display = stringValue(item.display);
    const id = stringValue(item.id);
    if (hash === undefined || display === undefined) {
      throw new Error("database field proxy_api_key_hashes_json has an invalid key entry");
    }
    return { hash, display, id: id ?? keyId(hash) };
  });
}

async function resolveProxyApiKeyUpdate(update: ProxyApiKeyUpdate, existing: KeyFingerprint[]): Promise<KeyFingerprint[]> {
  if (typeof update === "string") {
    return keyFingerprints(parseKeyList(update, "proxyApiKeys"));
  }
  const byId = new Map(existing.map((item) => [item.id, item]));
  const next: KeyFingerprint[] = [];
  for (const item of update) {
    if (item.value !== undefined) {
      const hash = await sha256Hex(item.value);
      next.push({
        hash,
        id: keyId(hash),
        display: redact(item.value),
      });
      continue;
    }
    if (item.id === undefined) {
      throw new Error("proxyApiKeys entries must include id or value");
    }
    const current = byId.get(item.id);
    if (current === undefined) {
      throw new Error("proxyApiKeys entry id is unknown");
    }
    next.push(current);
  }
  if (next.length === 0) {
    throw new Error("proxyApiKeys must include at least one key");
  }
  const seen = new Set<string>();
  for (const item of next) {
    if (seen.has(item.hash)) {
      throw new Error("proxyApiKeys must not include duplicate keys");
    }
    seen.add(item.hash);
  }
  return relabelProxyKeys(next);
}

function relabelProxyKeys(items: KeyFingerprint[]): KeyFingerprint[] {
  return items.map((item, index) => ({
    ...item,
    display: `KEY ${index + 1} · ${proxyKeyDisplaySecret(item.display)}`,
  }));
}

function proxyKeyDisplaySecret(display: string): string {
  const marker = " · ";
  const index = display.indexOf(marker);
  return index < 0 ? display : display.slice(index + marker.length);
}

function keyId(hash: string): string {
  return `key_${hash.slice(0, 16)}`;
}
