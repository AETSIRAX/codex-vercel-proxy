import { stringValue } from "./utils.js";

export interface AppEnv {
  [key: string]: string | undefined;
  ADMIN_TOKEN?: string;
  CODEX_BASE_URL?: string;
  CRED_ENCRYPTION_KEY?: string;
  CRON_SECRET?: string;
  DATABASE_URL?: string;
  FAILURE_COOLDOWN_SECONDS?: string;
  MODELS?: string;
  PROXY_API_KEY?: string;
  RATE_LIMIT_REFRESH_MIN_INTERVAL_SECONDS?: string;
  REFRESH_LEAD_SECONDS?: string;
  REFRESH_LOCK_SECONDS?: string;
  REFRESH_MIN_INTERVAL_SECONDS?: string;
  USER_AGENT?: string;
}

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

export function codexBaseURL(env: AppEnv): string {
  return (env.CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");
}

export function configuredModels(env: AppEnv): string[] {
  return (env.MODELS || "gpt-5.5,gpt-5.4")
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model !== "");
}

export function userAgent(env: AppEnv): string {
  return env.USER_AGENT || "codex-tui/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9 (codex-tui; 0.118.0)";
}
