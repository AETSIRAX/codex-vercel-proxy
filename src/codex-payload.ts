import type { ProxySettings } from "./settings.js";
import type { JsonObject, JsonValue } from "./types.js";
import { isRecord, stringValue } from "./utils.js";

// gpt-5.6 models use the upstream "responses lite" protocol: requests carry the
// x-openai-internal-codex-responses-lite header, parallel_tool_calls false and
// reasoning.context "all_turns"; client-executed tools and instructions travel
// inside `input` as an additional_tools item and a developer message.
const RESPONSES_LITE_MODEL_PREFIX = "gpt-5.6";
// The lite upstream only supports client-executed tools ("only supports function
// tools, custom tools, and client-executed tool search"); hosted tools such as
// web_search stay top-level so the upstream rejects them with that explicit error
// instead of the model silently not seeing the tool.
const RESPONSES_LITE_CLIENT_TOOL_TYPES = new Set(["function", "custom"]);

export function isResponsesLiteModel(model: string | undefined): boolean {
  return (
    model !== undefined &&
    (model === RESPONSES_LITE_MODEL_PREFIX || model.startsWith(`${RESPONSES_LITE_MODEL_PREFIX}-`))
  );
}

export function prepareCodexPayload(input: JsonObject, forceStream: boolean, settings: ProxySettings): JsonObject {
  const payload = structuredClone(input) as JsonObject;
  if (typeof payload.input === "string") {
    payload.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: payload.input }] }];
  }
  if (forceStream) {
    payload.stream = true;
  }
  payload.store = false;
  payload.parallel_tool_calls = true;
  delete payload.previous_response_id;
  delete payload.prompt_cache_retention;
  delete payload.safety_identifier;
  delete payload.max_output_tokens;
  delete payload.max_completion_tokens;
  delete payload.max_tokens;
  delete payload.temperature;
  delete payload.top_p;
  delete payload.truncation;
  delete payload.context_management;
  delete payload.user;
  delete payload.service_tier;
  if (settings.fastMode) {
    payload.service_tier = "priority";
  }
  normalizeResponsesInputRoles(payload);
  normalizeCodexBuiltinTools(payload);
  if (!("instructions" in payload) || payload.instructions === null) {
    payload.instructions = "";
  }
  normalizeReasoningEffort(payload);
  normalizeStreamOptions(payload);
  if (isResponsesLiteModel(stringValue(payload.model))) {
    applyResponsesLiteFormat(payload);
  }
  normalizeReasoningInclude(payload);
  return payload;
}

function normalizeReasoningInclude(payload: JsonObject): void {
  const include = Array.isArray(payload.include) ? payload.include : [];
  const filtered = include.filter((item) => item !== "reasoning.encrypted_content") as JsonValue[];
  if (isRecord(payload.reasoning)) {
    filtered.push("reasoning.encrypted_content");
  }
  if (filtered.length > 0) {
    payload.include = filtered;
  } else {
    delete payload.include;
  }
}

// "ultra" is a codex client-side reasoning level; the upstream wire value is "max".
function normalizeReasoningEffort(payload: JsonObject): void {
  if (isRecord(payload.reasoning) && payload.reasoning.effort === "ultra") {
    payload.reasoning.effort = "max";
  }
}

function normalizeStreamOptions(payload: JsonObject): void {
  const streamOptions = isRecord(payload.stream_options) ? payload.stream_options : undefined;
  if (streamOptions?.reasoning_summary_delivery === "sequential_cutoff") {
    payload.stream_options = { reasoning_summary_delivery: "sequential_cutoff" };
    return;
  }
  delete payload.stream_options;
}

function applyResponsesLiteFormat(payload: JsonObject): void {
  payload.parallel_tool_calls = false;
  // The lite upstream rejects requests without reasoning.context "all_turns".
  const reasoning = isRecord(payload.reasoning) ? payload.reasoning : {};
  if (reasoning.context === undefined) {
    reasoning.context = "all_turns";
  }
  payload.reasoning = reasoning;
  const input = Array.isArray(payload.input) ? payload.input : undefined;
  if (input !== undefined) {
    stripImageDetails(input);
  }
  if (input === undefined || input.some((item) => isRecord(item) && item.type === "additional_tools")) {
    return;
  }
  const prefix: JsonValue[] = [];
  const tools = Array.isArray(payload.tools) ? payload.tools : undefined;
  if (tools !== undefined && tools.length > 0) {
    const isClientTool = (tool: JsonValue): boolean =>
      isRecord(tool) && RESPONSES_LITE_CLIENT_TOOL_TYPES.has(stringValue(tool.type) ?? "");
    const clientTools = tools.filter(isClientTool);
    const hostedTools = tools.filter((tool) => !isClientTool(tool));
    if (clientTools.length > 0) {
      prefix.push({ type: "additional_tools", role: "developer", tools: clientTools });
    }
    if (hostedTools.length > 0) {
      payload.tools = hostedTools;
    } else {
      delete payload.tools;
    }
  }
  const instructions = stringValue(payload.instructions);
  if (instructions !== undefined && instructions !== "") {
    prefix.push({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: instructions }],
    });
    payload.instructions = "";
  }
  if (prefix.length > 0) {
    input.unshift(...prefix);
  }
}

function stripImageDetails(items: JsonValue[]): void {
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.type === "message") {
      stripImageDetailsFromContent(item.content);
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      stripImageDetailsFromContent(item.output);
    }
  }
}

function stripImageDetailsFromContent(content: unknown): void {
  if (!Array.isArray(content)) {
    return;
  }
  for (const part of content) {
    if (isRecord(part) && part.type === "input_image") {
      delete part.detail;
    }
  }
}

function normalizeResponsesInputRoles(payload: JsonObject): void {
  if (!Array.isArray(payload.input)) {
    return;
  }
  for (const item of payload.input) {
    if (isRecord(item) && item.role === "system") {
      item.role = "developer";
    }
  }
}

function normalizeCodexBuiltinTools(payload: JsonObject): void {
  normalizeToolArray(payload.tools);

  const toolChoice = payload.tool_choice;
  if (!isRecord(toolChoice)) {
    return;
  }
  normalizeToolObject(toolChoice);
  normalizeToolArray(toolChoice.tools);
}

function normalizeToolArray(value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    if (isRecord(item)) {
      normalizeToolObject(item);
    }
  }
}

function normalizeToolObject(tool: Record<string, unknown>): void {
  const type = stringValue(tool.type);
  if (type === "web_search_preview" || type === "web_search_preview_2025_03_11") {
    tool.type = "web_search";
  }
}
