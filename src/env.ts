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
// Exact CLI version bundled with the currently verified Codex App. Requests from
// Codex clients keep their own Version header, so App upgrades do not depend on
// this default being updated first.
export const DEFAULT_CODEX_CLI_VERSION = "0.146.0-alpha.3.1";

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
  return (env.MODELS || "gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4")
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
