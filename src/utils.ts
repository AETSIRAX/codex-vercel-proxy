import * as zlib from "node:zlib";

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

// Thrown by readJsonObject when the client's body cannot be used; index.ts maps
// it to the given HTTP status instead of a generic 500.
export class RequestBodyError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RequestBodyError";
    this.status = status;
    this.code = code;
  }
}

const IDENTITY_CONTENT_ENCODINGS = new Set(["", "identity"]);

export async function readJsonObject(request: Request): Promise<JsonObject> {
  const body = await readRequestBody(request);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new RequestBodyError(400, "invalid_request_body", "request body must be valid JSON");
  }
  if (!isJsonObject(value)) {
    throw new RequestBodyError(400, "invalid_request_body", "request body must be a JSON object");
  }
  return value;
}

// Codex CLI compresses request bodies with zstd (enable_request_compression is
// on by default for ChatGPT auth). Node's built-in zlib gained zstd in 22.15, so
// decode here; on older runtimes tell the operator to disable the feature.
async function readRequestBody(request: Request): Promise<string> {
  const encoding = (request.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (IDENTITY_CONTENT_ENCODINGS.has(encoding)) {
    return request.text();
  }
  const decompress = requestBodyDecoder(encoding);
  if (decompress === undefined) {
    throw new RequestBodyError(
      415,
      "unsupported_content_encoding",
      encoding === "zstd"
        ? `zstd request bodies need Node.js >= 22.15 (running ${process.version}); ` +
          "set enable_request_compression = false in the Codex client config or upgrade the runtime"
        : `unsupported Content-Encoding "${encoding}"`,
    );
  }
  const compressed = new Uint8Array(await request.arrayBuffer());
  try {
    return bytesToText(decompress(compressed));
  } catch (error) {
    throw new RequestBodyError(
      400,
      "invalid_request_body",
      `failed to decode ${encoding} request body: ${normalizeErrorMessage(error)}`,
    );
  }
}

type BodyDecoder = (input: Uint8Array) => Uint8Array;

function requestBodyDecoder(encoding: string): BodyDecoder | undefined {
  switch (encoding) {
    case "zstd":
      // Accessed dynamically so the import still links on runtimes without zstd.
      return typeof zlib.zstdDecompressSync === "function" ? (input) => zlib.zstdDecompressSync(input) : undefined;
    case "gzip":
    case "x-gzip":
      return (input) => zlib.gunzipSync(input);
    case "deflate":
      return (input) => zlib.inflateSync(input);
    case "br":
      return (input) => zlib.brotliDecompressSync(input);
    default:
      return undefined;
  }
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

const UUID_V5_NAMESPACE_OID = "6ba7b8129dad11d180b400c04fd430c8";

export async function uuidV5(name: string, namespaceHex: string = UUID_V5_NAMESPACE_OID): Promise<string> {
  const namespace = hexToBytes(namespaceHex);
  const nameBytes = textToBytes(name);
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
