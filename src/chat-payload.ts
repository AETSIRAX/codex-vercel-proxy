import type { JsonObject } from "./types.js";
import { isRecord, stringValue } from "./utils.js";

export function resolveChatVerbosity(input: JsonObject): string | undefined {
  const text = isRecord(input.text) ? input.text : undefined;
  return stringValue(input.verbosity) ?? stringValue(text?.verbosity);
}
