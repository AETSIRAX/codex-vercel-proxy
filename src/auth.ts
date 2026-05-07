import { envString, type AppEnv } from "./env.js";
import { settingsStore } from "./settings.js";
import { constantTimeEqual, errorResponse, sha256Hex } from "./utils.js";

export async function requireProxyAuth(request: Request, env: AppEnv): Promise<Response | undefined> {
  const settings = await settingsStore(env).getAuthSettings();
  return requireBearerHashAny(request, settings.proxyApiKeyHashes, "PROXY_API_KEY");
}

export async function requireAdminAuth(request: Request, env: AppEnv): Promise<Response | undefined> {
  const settings = await settingsStore(env).getAuthSettings();
  return requireBearerHash(request, settings.adminTokenHash, "ADMIN_TOKEN");
}

export async function requireCronAuth(request: Request, env: AppEnv): Promise<Response | undefined> {
  return requireBearer(request, envString(env, "CRON_SECRET"), "CRON_SECRET");
}

async function requireBearer(request: Request, expected: string | undefined, secretName: string): Promise<Response | undefined> {
  if (!expected) {
    return errorResponse(500, `${secretName} secret is required`, "missing_secret");
  }
  return requireBearerAny(request, [expected], secretName);
}

async function requireBearerHash(
  request: Request,
  expectedHash: string | undefined,
  secretName: string,
): Promise<Response | undefined> {
  if (!expectedHash) {
    return errorResponse(500, `${secretName} secret is required`, "missing_secret");
  }
  return requireBearerHashAny(request, [expectedHash], secretName);
}

async function requireBearerAny(request: Request, expected: string[], secretName: string): Promise<Response | undefined> {
  if (expected.length === 0) {
    return errorResponse(500, `${secretName} secret is required`, "missing_secret");
  }
  const provided = bearerToken(request) ?? request.headers.get("x-api-key") ?? "";
  const matches = await Promise.all(expected.map((value) => constantTimeEqual(provided, value)));
  if (!matches.some(Boolean)) {
    return errorResponse(401, "invalid bearer token", "unauthorized");
  }
  return undefined;
}

async function requireBearerHashAny(
  request: Request,
  expectedHashes: string[],
  secretName: string,
): Promise<Response | undefined> {
  if (expectedHashes.length === 0) {
    return errorResponse(500, `${secretName} secret is required`, "missing_secret");
  }
  const provided = bearerToken(request) ?? request.headers.get("x-api-key") ?? "";
  const providedHash = await sha256Hex(provided);
  const matches = await Promise.all(expectedHashes.map((value) => constantTimeEqual(providedHash, value)));
  if (!matches.some(Boolean)) {
    return errorResponse(401, "invalid bearer token", "unauthorized");
  }
  return undefined;
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}
