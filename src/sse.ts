import type { JsonObject } from "./types.js";
import { isRecord } from "./utils.js";

export interface SseDataEvent {
  data: string;
}

export async function* readSseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseDataEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          break;
        }
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === "") {
          if (dataLines.length > 0) {
            yield { data: dataLines.join("\n") };
            dataLines = [];
          }
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith("data:")) {
      dataLines.push(buffer.slice(5).trimStart());
    }
    if (dataLines.length > 0) {
      yield { data: dataLines.join("\n") };
    }
  } finally {
    reader.releaseLock();
  }
}

export function encodeSseData(value: string | JsonObject): Uint8Array {
  const data = typeof value === "string" ? value : JSON.stringify(value);
  return new TextEncoder().encode(`data: ${data}\n\n`);
}

export function parseSseJson(data: string): JsonObject | undefined {
  if (data === "[DONE]") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) ? (parsed as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}
