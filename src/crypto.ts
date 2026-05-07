import { base64UrlDecode, base64UrlEncode, bytesToText, textToBytes } from "./utils.js";

const AES_GCM_IV_BYTES = 12;

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", textToBytes(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptJson(secret: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const key = await encryptionKey(secret);
  const plaintext = textToBytes(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

export async function decryptJson<T>(secret: string, encrypted: string): Promise<T> {
  const parts = encrypted.split(".");
  if (parts.length !== 2) {
    throw new Error("credential payload has invalid encryption format");
  }
  const iv = base64UrlDecode(parts[0]);
  const ciphertext = base64UrlDecode(parts[1]);
  const key = await encryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(bytesToText(new Uint8Array(plaintext))) as T;
}
