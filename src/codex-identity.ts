import type { ProxySettings } from "./settings.js";
import type { JsonObject, SelectedCredential } from "./types.js";
import { isRecord, stringValue } from "./utils.js";

const UUID_V5_NAMESPACE_OID = "6ba7b8129dad11d180b400c04fd430c8";
const IDENTITY_CONFUSE_NAME_PREFIX = "codex-vercel-proxy:codex:identity-confuse:";

export interface CodexIdentityState {
  authId?: string;
  enabled: boolean;
  originalPromptCacheKey?: string;
  promptCacheKey?: string;
  stableIds: CodexIdentityReplacement[];
}

export interface CodexIdentityReplacement {
  confused: string;
  original: string;
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
  const state: CodexIdentityState = { authId: credential.id.trim(), enabled: true, stableIds: [] };
  const promptCacheKey = stringValue(sourcePayload.prompt_cache_key);
  if (promptCacheKey !== undefined) {
    state.originalPromptCacheKey = promptCacheKey;
    state.promptCacheKey = await codexIdentityConfuseUUID(credential.id, "prompt-cache", promptCacheKey);
    upstreamPayload.prompt_cache_key = state.promptCacheKey;
  }

  const metadata = isRecord(upstreamPayload.client_metadata) ? upstreamPayload.client_metadata : undefined;
  const sourceMetadata = isRecord(sourcePayload.client_metadata) ? sourcePayload.client_metadata : metadata;
  if (metadata !== undefined) {
    const installationId = stringValue(sourceMetadata?.["x-codex-installation-id"]);
    if (installationId !== undefined) {
      metadata["x-codex-installation-id"] = await codexIdentityConfuseUUID(credential.id, "installation", installationId);
    }
  }

  return state;
}

export async function applyCodexIdentityConfuseHeaders(headers: Headers, state: CodexIdentityState): Promise<void> {
  if (!state.enabled) {
    return;
  }
  const authId = state.authId ?? "";
  if (authId.trim() === "") {
    return;
  }
  const sessionId = stringValue(headers.get("session-id"));
  const threadId = stringValue(headers.get("thread-id"));
  const requestId = stringValue(headers.get("X-Client-Request-Id"));
  const confusedSessionId =
    sessionId === undefined ? undefined : await confuseCodexStableId(state, authId, sessionId);
  const confusedThreadId = threadId === undefined ? undefined : await confuseCodexStableId(state, authId, threadId);

  if (confusedSessionId !== undefined) {
    headers.set("session-id", confusedSessionId);
  }
  if (confusedThreadId !== undefined) {
    headers.set("thread-id", confusedThreadId);
  }
  if (requestId !== undefined && requestId === sessionId && confusedSessionId !== undefined) {
    headers.set("X-Client-Request-Id", confusedSessionId);
  } else if (requestId !== undefined && requestId === threadId && confusedThreadId !== undefined) {
    headers.set("X-Client-Request-Id", confusedThreadId);
  }
}

export function applyCodexIdentityExposeText(value: string, state: CodexIdentityState): string {
  if (!state.enabled) {
    return value;
  }
  let out = replaceCodexIdentity(value, state.promptCacheKey, state.originalPromptCacheKey);
  for (const replacement of state.stableIds) {
    out = replaceCodexIdentity(out, replacement.confused, replacement.original);
  }
  return out;
}

function emptyCodexIdentityState(): CodexIdentityState {
  return { enabled: false, stableIds: [] };
}

function replaceCodexIdentity(value: string, from: string | undefined, to: string | undefined): string {
  const source = from?.trim();
  const target = to?.trim();
  if (!source || !target || source === target || !value.includes(source)) {
    return value;
  }
  return value.split(source).join(target);
}

async function confuseCodexStableId(state: CodexIdentityState, authId: string, value: string): Promise<string> {
  const trimmed = value.trim();
  if (!state.enabled || authId.trim() === "" || trimmed === "") {
    return value;
  }
  if (
    state.originalPromptCacheKey !== undefined &&
    state.promptCacheKey !== undefined &&
    trimmed === state.originalPromptCacheKey.trim()
  ) {
    return state.promptCacheKey;
  }
  const existing = state.stableIds.find(
    (replacement) => replacement.original === trimmed || replacement.confused === trimmed,
  );
  if (existing !== undefined) {
    return existing.confused;
  }
  const confused = await codexIdentityConfuseUUID(authId, "stable-id", trimmed);
  state.stableIds.push({ original: trimmed, confused });
  return confused;
}

async function codexIdentityConfuseUUID(authId: string, kind: string, value: string): Promise<string> {
  return uuidV5(`${IDENTITY_CONFUSE_NAME_PREFIX}${kind}:${authId.trim()}:${value.trim()}`, UUID_V5_NAMESPACE_OID);
}

async function uuidV5(name: string, namespaceHex: string): Promise<string> {
  const namespace = hexToBytes(namespaceHex);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(namespace.length + nameBytes.length);
  input.set(namespace, 0);
  input.set(nameBytes, namespace.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
