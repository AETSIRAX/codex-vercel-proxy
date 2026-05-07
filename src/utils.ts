import type { JsonObject } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function textToBytes(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value);
}

export function bytesToText(value: Uint8Array): string {
  return decoder.decode(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

export function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function contentStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

export function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "unknown error";
}

export function jsonResponse(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function errorResponse(status: number, message: string, code = "worker_proxy_error"): Response {
  return jsonResponse(
    {
      error: {
        message,
        type: "invalid_request_error",
        code,
      },
    },
    { status },
  );
}

export async function readJsonObject(request: Request): Promise<JsonObject> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new Error("request body must be valid JSON");
  }
  if (!isJsonObject(value)) {
    throw new Error("request body must be a JSON object");
  }
  return value;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textToBytes(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", textToBytes(left)),
    crypto.subtle.digest("SHA-256", textToBytes(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= leftBytes[index] ^ rightBytes[index];
  }
  return diff === 0;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

export function parseTime(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : undefined;
}

export function isoTime(millis: number | undefined): string | undefined {
  if (millis === undefined || !Number.isFinite(millis) || millis <= 0) {
    return undefined;
  }
  return new Date(millis).toISOString();
}

export function redact(value: string, visible = 6): string {
  if (value.length <= visible * 2) {
    return "***";
  }
  return `${value.slice(0, visible)}...${value.slice(-visible)}`;
}

export function requestAuthIdentity(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    const token = match?.[1]?.trim();
    if (token) {
      return token;
    }
  }
  const apiKey = request.headers.get("x-api-key")?.trim();
  return apiKey === "" ? undefined : apiKey;
}

export function optionalDbNumber(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`database field ${field} must be numeric`);
}

export function requiredDbNumber(value: unknown, field: string): number {
  const parsed = optionalDbNumber(value, field);
  if (parsed === undefined) {
    throw new Error(`database field ${field} is required`);
  }
  return parsed;
}

export function lazySingleton<T>(factory: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return (): Promise<T> => {
    if (!promise) {
      promise = factory().catch((err: unknown) => {
        promise = undefined;
        throw err;
      });
    }
    return promise;
  };
}
