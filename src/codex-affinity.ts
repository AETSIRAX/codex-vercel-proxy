import { sha256Hex, stringValue } from "./utils.js";

export function resolveCodexCredentialAffinityKey(request: Request): string | undefined {
  return stringValue(request.headers.get("session-id")) ?? stringValue(request.headers.get("thread-id"));
}

export async function rankCredentialIdsByAffinity(affinityKey: string, credentialIds: string[]): Promise<string[]> {
  const key = affinityKey.trim();
  const ids = [...new Set(credentialIds.map((id) => id.trim()).filter((id) => id !== ""))];
  if (key === "" || ids.length <= 1) {
    return ids;
  }
  const scored = await Promise.all(
    ids.map(async (id) => ({
      id,
      score: await sha256Hex(`codex-affinity:${key}:${id}`),
    })),
  );
  scored.sort((left, right) => {
    const byScore = right.score.localeCompare(left.score);
    return byScore === 0 ? left.id.localeCompare(right.id) : byScore;
  });
  return scored.map((item) => item.id);
}
