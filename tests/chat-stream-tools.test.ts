import assert from "node:assert/strict";
import test from "node:test";

import { ToolCallTracker, toolCallKeysFromEvent } from "../src/chat-stream-tools.js";

test("interleaved argument deltas map to their own tool call index", () => {
  const tracker = new ToolCallTracker();
  const a = tracker.add(toolCallKeysFromEvent({ output_index: 1, item: { id: "fc_a", call_id: "call_a" } }));
  const b = tracker.add(toolCallKeysFromEvent({ output_index: 2, item: { id: "fc_b", call_id: "call_b" } }));

  assert.equal(a.index, 0);
  assert.equal(b.index, 1);
  assert.equal(tracker.resolve(toolCallKeysFromEvent({ item_id: "fc_a", output_index: 1 })), a);
  assert.equal(tracker.resolve(toolCallKeysFromEvent({ item_id: "fc_b", output_index: 2 })), b);
  assert.equal(tracker.resolve({ callId: "call_a" }), a);
  assert.equal(tracker.resolve({ outputIndex: 2 }), b);
  assert.equal(tracker.count, 2);
});

test("keyless events fall back to the last added call; unknown keys do not", () => {
  const tracker = new ToolCallTracker();
  const first = tracker.add({ itemId: "fc_1", outputIndex: 0 });
  const second = tracker.add({ itemId: "fc_2", outputIndex: 1 });

  assert.equal(tracker.resolve({}), second);
  assert.notEqual(tracker.resolve({}), first);
  assert.equal(tracker.resolve({ itemId: "fc_3" }), undefined);
  assert.equal(tracker.find({ outputIndex: 5 }), undefined);
});

test("event keys are read from item_id, output_index and the item itself", () => {
  assert.deepEqual(toolCallKeysFromEvent({ type: "response.function_call_arguments.delta", item_id: "fc_9", output_index: 3 }), {
    itemId: "fc_9",
    outputIndex: 3,
    callId: undefined,
  });
  assert.deepEqual(
    toolCallKeysFromEvent({ type: "response.output_item.done", output_index: 0, item: { id: "fc_1", call_id: "call_1" } }),
    { itemId: "fc_1", outputIndex: 0, callId: "call_1" },
  );
});
