import { base64UrlDecode, booleanValue, isRecord, stringValue } from "./utils.js";

export interface JwtIdentity {
  accountId?: string;
  email?: string;
  expiresAt?: string;
  planType?: string;
  userId?: string;
  fedramp?: boolean;
}

export function parseJwtIdentity(token: string | undefined): JwtIdentity {
  if (!token) {
    return {};
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return {};
  }
  try {
    const raw = new TextDecoder().decode(base64UrlDecode(parts[1]));
    const payload: unknown = JSON.parse(raw);
    if (!isRecord(payload)) {
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
    const exp = typeof payload.exp === "number" ? payload.exp : undefined;
    if (exp !== undefined && Number.isFinite(exp) && exp > 0) {
      identity.expiresAt = new Date(exp * 1000).toISOString();
    }
    return identity;
  } catch {
    return {};
  }
}
