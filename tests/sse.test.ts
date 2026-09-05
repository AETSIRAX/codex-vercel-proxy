import assert from "node:assert/strict";
import test from "node:test";

import { readSseData, readSseDataFromReader } from "../src/sse.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

test("data events are reassembled across chunk boundaries", async () => {
  const events: string[] = [];
  for await (const event of readSseData(streamOf(['data: {"a":', '1}\n\n', "data: [DONE]\n\n"]))) {
    events.push(event.data);
  }
  assert.deepEqual(events, ['{"a":1}', "[DONE]"]);
});

test("cancelling the reader ends the loop like a normal EOF", async () => {
  let pulls = 0;
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(encoder.encode(`data: {"n":${pulls}}\n\n`));
    },
  });
  const reader = upstream.getReader();
  const seen: string[] = [];
  for await (const event of readSseDataFromReader(reader)) {
    seen.push(event.data);
    if (seen.length === 2) {
      await reader.cancel("client went away");
    }
  }
  assert.deepEqual(seen.slice(0, 2), ['{"n":1}', '{"n":2}']);
  assert.ok(seen.length <= 3);
});
