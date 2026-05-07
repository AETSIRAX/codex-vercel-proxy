import type { ProxySettings } from "./settings.js";
import type { JsonObject, JsonValue, SelectedCredential } from "./types.js";
import { isRecord, stringValue, uuidV5 } from "./utils.js";

const IDENTITY_CONFUSE_NAME_PREFIX = "codex-vercel-proxy:codex:identity-confuse:";

type CodexIdentityKind = "installation" | "prompt-cache" | "stable-id" | "window-id";

const INSTALLATION_ID_KEYS = new Set(["installation_id", "x-codex-installation-id"]);
const PROMPT_CACHE_KEY_KEYS = new Set(["prompt_cache_key"]);
const STABLE_ID_KEYS = new Set([
  "forked_from_thread_id",
  "parent_thread_id",
  "session_id",
  "thread_id",
  "turn_id",
  "x-client-request-id",
  "x-codex-parent-thread-id",
]);
const TURN_METADATA_KEYS = new Set(["x-codex-turn-metadata"]);
const WINDOW_ID_KEYS = new Set(["window_id", "x-codex-window-id"]);

export interface CodexIdentityState {
  authId?: string;
  enabled: boolean;
  originalPromptCacheKey?: string;
  promptCacheKey?: string;
  replacements: CodexIdentityReplacement[];
}

export interface CodexIdentityReplacement {
  confused: string;
  kind: CodexIdentityKind;
  original: string;
}

export class CodexIdentityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexIdentityInputError";
  }
}

export async function applyCodexIdentityConfusePayload(
  settings: Pick<ProxySettings, "identityConfuse">,
  credential: Pick<SelectedCredential, "id">,
  sourcePayload: JsonObject,
  upstreamPayload: JsonObject,
): Promise<CodexIdentityState> {
  if (!settings.identityConfuse || credential.id.trim() === "") {
    return emptyCodexIdentityState();
  }
  const state: CodexIdentityState = { authId: credential.id.trim(), enabled: true, replacements: [] };
  const promptCacheKey = stringValue(sourcePayload.prompt_cache_key);
  if (promptCacheKey !== undefined) {
    state.originalPromptCacheKey = promptCacheKey;
    state.promptCacheKey = await confuseCodexIdentity(state, "prompt-cache", promptCacheKey);
    upstreamPayload.prompt_cache_key = state.promptCacheKey;
  }

  const metadata = isRecord(upstreamPayload.client_metadata) ? upstreamPayload.client_metadata : undefined;
  const sourceMetadata = isRecord(sourcePayload.client_metadata) ? sourcePayload.client_metadata : metadata;
  if (metadata !== undefined && sourceMetadata !== undefined) {
    await confuseMetadataField(metadata, sourceMetadata, "x-codex-installation-id", "installation", state);
    await confuseMetadataField(metadata, sourceMetadata, "installation_id", "installation", state);
    for (const key of ["session_id", "thread_id", "turn_id", "x-codex-parent-thread-id"] as const) {
      await confuseMetadataField(metadata, sourceMetadata, key, "stable-id", state);
    }
    await confuseWindowMetadataField(metadata, sourceMetadata, "x-codex-window-id", state);

    const turnMetadata = stringValue(sourceMetadata["x-codex-turn-metadata"]);
    if (turnMetadata !== undefined) {
      metadata["x-codex-turn-metadata"] = await confuseCodexTurnMetadata(turnMetadata, state);
    }
  }

  return state;
}

export async function applyCodexIdentityConfuseHeaders(headers: Headers, state: CodexIdentityState): Promise<void> {
  if (!state.enabled || !state.authId) {
    return;
  }

  await confuseHeader(headers, "session-id", "stable-id", state);
  await confuseHeader(headers, "thread-id", "stable-id", state);
  await confuseHeader(headers, "x-client-request-id", "stable-id", state);
  await confuseHeader(headers, "x-codex-parent-thread-id", "stable-id", state);
  await confuseHeader(headers, "x-codex-installation-id", "installation", state);

  const windowId = stringValue(headers.get("x-codex-window-id"));
  if (windowId !== undefined) {
    headers.set("x-codex-window-id", await confuseCodexWindowId(windowId, state));
  }

  const turnMetadata = stringValue(headers.get("x-codex-turn-metadata"));
  if (turnMetadata !== undefined) {
    headers.set("x-codex-turn-metadata", await confuseCodexTurnMetadata(turnMetadata, state));
  }
}

export function applyCodexIdentityExposeJson(value: JsonObject, state: CodexIdentityState): JsonObject {
  if (!state.enabled) {
    return value;
  }
  const exposed = structuredClone(value) as JsonObject;
  exposeCodexIdentityValue(exposed, state);
  return exposed;
}

export function applyCodexIdentityExposeHeaders(headers: Headers, state: CodexIdentityState): void {
  if (!state.enabled) {
    return;
  }
  for (const name of [
    "session-id",
    "thread-id",
    "x-client-request-id",
    "x-codex-parent-thread-id",
    "x-codex-installation-id",
  ]) {
    const value = stringValue(headers.get(name));
    if (value !== undefined) {
      headers.set(name, exposeKnownIdentity(value, state));
    }
  }
  const windowId = stringValue(headers.get("x-codex-window-id"));
  if (windowId !== undefined) {
    headers.set("x-codex-window-id", exposeCodexWindowId(windowId, state));
  }
  const turnMetadata = stringValue(headers.get("x-codex-turn-metadata"));
  if (turnMetadata !== undefined) {
    headers.set("x-codex-turn-metadata", exposeCodexTurnMetadata(turnMetadata, state));
  }
}

export function applyCodexIdentityExposeText(value: string, state: CodexIdentityState): string {
  if (!state.enabled) {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      return value;
    }
    return JSON.stringify(applyCodexIdentityExposeJson(parsed as JsonObject, state));
  } catch {
    return value;
  }
}

function emptyCodexIdentityState(): CodexIdentityState {
  return { enabled: false, replacements: [] };
}

async function confuseMetadataField(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
  kind: CodexIdentityKind,
  state: CodexIdentityState,
): Promise<void> {
  const value = stringValue(source[key]);
  if (value !== undefined) {
    target[key] = await confuseCodexIdentity(state, kind, value);
  }
}

async function confuseWindowMetadataField(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
  state: CodexIdentityState,
): Promise<void> {
  const value = stringValue(source[key]);
  if (value !== undefined) {
    target[key] = await confuseCodexWindowId(value, state);
  }
}

async function confuseHeader(
  headers: Headers,
  name: string,
  kind: CodexIdentityKind,
  state: CodexIdentityState,
): Promise<void> {
  const value = stringValue(headers.get(name));
  if (value !== undefined) {
    headers.set(name, await confuseCodexIdentity(state, kind, value));
  }
}

async function confuseCodexTurnMetadata(raw: string, state: CodexIdentityState): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CodexIdentityInputError("x-codex-turn-metadata must be valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new CodexIdentityInputError("x-codex-turn-metadata must be a JSON object");
  }

  const metadata = parsed as Record<string, JsonValue>;
  const promptCacheKey = stringValue(metadata.prompt_cache_key);
  if (promptCacheKey !== undefined) {
    metadata.prompt_cache_key =
      state.promptCacheKey ?? (await confuseCodexIdentity(state, "prompt-cache", promptCacheKey));
  }
  for (const key of ["session_id", "thread_id", "turn_id", "forked_from_thread_id", "parent_thread_id"] as const) {
    const value = stringValue(metadata[key]);
    if (value !== undefined) {
      metadata[key] = await confuseCodexIdentity(state, "stable-id", value);
    }
  }
  const installationId = stringValue(metadata.installation_id);
  if (installationId !== undefined) {
    metadata.installation_id = await confuseCodexIdentity(state, "installation", installationId);
  }
  const windowId = stringValue(metadata.window_id);
  if (windowId !== undefined) {
    metadata.window_id = await confuseCodexWindowId(windowId, state);
  }
  return stringifyAsciiJson(metadata);
}

async function confuseCodexWindowId(value: string, state: CodexIdentityState): Promise<string> {
  const trimmed = value.trim();
  const parts = /^(.*):(\d+)$/.exec(trimmed);
  if (parts?.[1]) {
    return `${await confuseCodexIdentity(state, "stable-id", parts[1])}:${parts[2]}`;
  }
  return confuseCodexIdentity(state, "window-id", trimmed);
}

async function confuseCodexIdentity(
  state: CodexIdentityState,
  kind: CodexIdentityKind,
  value: string,
): Promise<string> {
  const authId = state.authId?.trim() ?? "";
  const trimmed = value.trim();
  if (!state.enabled || authId === "" || trimmed === "") {
    return value;
  }
  if (
    kind === "stable-id" &&
    state.originalPromptCacheKey !== undefined &&
    state.promptCacheKey !== undefined &&
    trimmed === state.originalPromptCacheKey.trim()
  ) {
    return state.promptCacheKey;
  }
  const existing = state.replacements.find(
    (replacement) =>
      replacement.kind === kind && (replacement.original === trimmed || replacement.confused === trimmed),
  );
  if (existing !== undefined) {
    return existing.confused;
  }
  const confused = await codexIdentityConfuseUUID(authId, kind, trimmed);
  state.replacements.push({ kind, original: trimmed, confused });
  return confused;
}

function exposeCodexIdentityValue(value: JsonValue, state: CodexIdentityState): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      exposeCodexIdentityValue(item, state);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      if (TURN_METADATA_KEYS.has(key)) {
        value[key] = exposeCodexTurnMetadata(child, state);
      } else if (WINDOW_ID_KEYS.has(key)) {
        value[key] = exposeCodexWindowId(child, state);
      } else if (PROMPT_CACHE_KEY_KEYS.has(key) || INSTALLATION_ID_KEYS.has(key) || STABLE_ID_KEYS.has(key)) {
        value[key] = exposeKnownIdentity(child, state);
      }
      continue;
    }
    if (Array.isArray(child) || isRecord(child)) {
      exposeCodexIdentityValue(child as JsonValue, state);
    }
  }
}

function exposeCodexTurnMetadata(raw: string, state: CodexIdentityState): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return raw;
    }
    const metadata = structuredClone(parsed) as JsonObject;
    exposeCodexIdentityValue(metadata, state);
    return stringifyAsciiJson(metadata);
  } catch {
    return raw;
  }
}

function exposeCodexWindowId(value: string, state: CodexIdentityState): string {
  const trimmed = value.trim();
  const parts = /^(.*):(\d+)$/.exec(trimmed);
  if (parts?.[1]) {
    return `${exposeKnownIdentity(parts[1], state)}:${parts[2]}`;
  }
  return exposeKnownIdentity(trimmed, state);
}

function exposeKnownIdentity(value: string, state: CodexIdentityState): string {
  const trimmed = value.trim();
  return state.replacements.find((replacement) => replacement.confused === trimmed)?.original ?? value;
}

function stringifyAsciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

async function codexIdentityConfuseUUID(authId: string, kind: string, value: string): Promise<string> {
  return uuidV5(`${IDENTITY_CONFUSE_NAME_PREFIX}${kind}:${authId.trim()}:${value.trim()}`);
}
