import { base64UrlDecode, isRecord, stringValue } from "./utils.js";

export interface JwtIdentity {
  accountId?: string;
  email?: string;
  expiresAt?: string;
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
