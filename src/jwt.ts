import { base64UrlDecode, booleanValue, isRecord, stringValue } from "./utils.js";

export interface JwtIdentity {
  accountId?: string;
  email?: string;
  planType?: string;
  userId?: string;
  fedramp?: boolean;
}

export function parseJwtIdentity(token: string | undefined): JwtIdentity {
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return {};
  }
  const auth = payload["https://api.openai.com/auth"];
  const identity: JwtIdentity = {
    email: stringValue(payload.email),
  };
  if (isRecord(auth)) {
    identity.accountId = stringValue(auth.chatgpt_account_id);
    identity.planType = stringValue(auth.chatgpt_plan_type);
    identity.userId = stringValue(auth.chatgpt_user_id) ?? stringValue(auth.user_id);
    identity.fedramp = booleanValue(auth.chatgpt_account_is_fedramp);
  }
  return identity;
}

// Reads the `exp` claim as an ISO timestamp. Codex only looks at the access
// token's `exp` to decide when to refresh; the id_token expires on its own,
// much shorter schedule and must not be used for that.
export function parseJwtExpiration(token: string | undefined): string | undefined {
  const exp = decodeJwtPayload(token)?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) {
    return undefined;
  }
  return new Date(exp * 1000).toISOString();
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) {
    return undefined;
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    const raw = new TextDecoder().decode(base64UrlDecode(parts[1]));
    const payload: unknown = JSON.parse(raw);
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}
