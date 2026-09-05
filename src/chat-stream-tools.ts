import type { JsonObject } from "./types.js";
import { isRecord, numberValue, stringValue } from "./utils.js";

// Maps Responses function_call output items to chat.completion.chunk
// tool_calls indexes. Upstream may interleave argument deltas of parallel calls
// ("add A, add B, A args, B args"), so every event is matched by item_id,
// call_id or output_index instead of "the tool call added last".
export interface ToolCallKeys {
  itemId?: string;
  outputIndex?: number;
  callId?: string;
}

export interface ToolCallSlot {
  index: number;
  // A chunk carrying id / type / function.name was emitted for this call.
  announced: boolean;
  // Arguments were already streamed (or sent whole), so later copies are skipped.
  argumentsSent: boolean;
}

export function toolCallKeysFromEvent(event: JsonObject): ToolCallKeys {
  const item = isRecord(event.item) ? event.item : undefined;
  return {
    itemId: stringValue(event.item_id) ?? stringValue(item?.id),
    outputIndex: numberValue(event.output_index),
    callId: stringValue(item?.call_id),
  };
}

export class ToolCallTracker {
  private readonly byItemId = new Map<string, ToolCallSlot>();
  private readonly byCallId = new Map<string, ToolCallSlot>();
  private readonly byOutputIndex = new Map<number, ToolCallSlot>();
  private last: ToolCallSlot | undefined;
  private nextIndex = 0;

  get count(): number {
    return this.nextIndex;
  }

  add(keys: ToolCallKeys): ToolCallSlot {
    const slot: ToolCallSlot = { index: this.nextIndex, announced: false, argumentsSent: false };
    this.nextIndex += 1;
    if (keys.itemId !== undefined) {
      this.byItemId.set(keys.itemId, slot);
    }
    if (keys.callId !== undefined) {
      this.byCallId.set(keys.callId, slot);
    }
    if (keys.outputIndex !== undefined) {
      this.byOutputIndex.set(keys.outputIndex, slot);
    }
    this.last = slot;
    return slot;
  }

  find(keys: ToolCallKeys): ToolCallSlot | undefined {
    return (
      (keys.itemId !== undefined ? this.byItemId.get(keys.itemId) : undefined) ??
      (keys.callId !== undefined ? this.byCallId.get(keys.callId) : undefined) ??
      (keys.outputIndex !== undefined ? this.byOutputIndex.get(keys.outputIndex) : undefined)
    );
  }

  // Events without any usable key fall back to the most recently added call,
  // which is what a strictly sequential stream means anyway. Keyed events that
  // match nothing return undefined so the caller can register them.
  resolve(keys: ToolCallKeys): ToolCallSlot | undefined {
    const found = this.find(keys);
    if (found !== undefined) {
      return found;
    }
    const keyed = keys.itemId !== undefined || keys.callId !== undefined || keys.outputIndex !== undefined;
    return keyed ? undefined : this.last;
  }
}
