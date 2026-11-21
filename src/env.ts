import { CODEX_MODEL_CATALOG } from "./codex-models.js";
import { stringValue } from "./utils.js";

export interface AppEnv {
  [key: string]: string | undefined;
  ADMIN_TOKEN?: string;
  CRED_ENCRYPTION_KEY?: string;
  CODEX_CLI_VERSION?: string;
  CRON_SECRET?: string;
  DATABASE_URL?: string;
  FAILURE_COOLDOWN_SECONDS?: string;
  MODELS?: string;
  PROXY_API_KEY?: string;
  RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS?: string;
  REFRESH_LEAD_SECONDS?: string;
  REFRESH_LOCK_SECONDS?: string;
  REFRESH_MIN_INTERVAL_SECONDS?: string;
}

export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
// Matches the upstream release used for the model catalog snapshot.
export const DEFAULT_CODEX_CLI_VERSION = "0.170.0";

export function loadEnv(): AppEnv {
  return process.env;
}

export function envString(env: AppEnv, name: string): string | undefined {
  return stringValue(Reflect.get(env, name));
}

export function proxyApiKeys(env: AppEnv): string[] {
  const raw = envString(env, "PROXY_API_KEY");
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(/[,\n]+/)
    .map((key) => key.trim())
    .filter((key) => key !== "");
}

export function codexBaseURL(): string {
  return CHATGPT_CODEX_BASE_URL;
}

export function configuredModels(env: AppEnv): string[] {
  if (!env.MODELS) {
    return CODEX_MODEL_CATALOG.filter((model) => !model.hidden).map((model) => model.slug);
  }
  return env.MODELS
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model !== "");
}

export function codexClientVersion(env: AppEnv, source?: Headers): string {
  return source?.get("version")?.trim() || envString(env, "CODEX_CLI_VERSION") || DEFAULT_CODEX_CLI_VERSION;
}

export function userAgent(env: AppEnv, source?: Headers): string {
  return source?.get("user-agent")?.trim() || `codex_cli_rs/${codexClientVersion(env, source)}`;
}
