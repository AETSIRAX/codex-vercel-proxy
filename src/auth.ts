import { envString, proxyApiKeys, type AppEnv } from "./env.js";
import { constantTimeEqual, errorResponse } from "./utils.js";

export async function requireProxyAuth(request: Request, env: AppEnv): Promise<Response | undefined> {
  return requireBearerAny(request, proxyApiKeys(env), "PROXY_API_KEY");
}

export async function requireAdminAuth(request: Request, env: AppEnv): Promise<Response | undefined> {
  return requireBearer(request, envString(env, "ADMIN_TOKEN"), "ADMIN_TOKEN");
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

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}
