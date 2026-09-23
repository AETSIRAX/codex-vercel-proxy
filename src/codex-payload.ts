import {
  defaultServiceTier,
  isResponsesLiteModel,
  reasoningEffortForRequest,
  supportedServiceTiers,
} from "./codex-models.js";
import type { ProxySettings } from "./settings.js";
import type { JsonObject, JsonValue } from "./types.js";
import { isRecord, stringValue, uuidV5 } from "./utils.js";

export { isResponsesLiteModel } from "./codex-models.js";

export interface PayloadIdentity {
  // Thread id Codex derives the lite prefix item ids from. The proxy uses the
  // client's thread-id header, falling back to the prompt cache key.
  threadId?: string;
  promptCacheKey?: string;
}

export interface PayloadOptions {
  // Guardian reviewer requests (x-codex-guardian: reviewer) never carry a
  // service tier or routing hint in Codex.
  guardianReviewer?: boolean;
}

// Responses Lite models (see codex-models.ts) use the upstream "responses lite"
// protocol: requests carry the x-openai-internal-codex-responses-lite header,
// parallel_tool_calls false and reasoning.context "all_turns"; tools and
// instructions travel inside `input` as an additional_tools item and a developer
// message instead of the top-level fields.
const DEFAULT_FUNCTION_NAMESPACE = "functions";
const SERVICE_TIER_DEFAULT_REQUEST_VALUE = "default";
const SERVICE_TIER_FLEX = "flex";
const FAST_MODE_SERVICE_TIER = "priority";

export async function prepareCodexPayload(
  input: JsonObject,
  forceStream: boolean,
  settings: ProxySettings,
  identity: PayloadIdentity = {},
  options: PayloadOptions = {},
): Promise<JsonObject> {
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
  applyServiceTier(payload, stringValue(input.service_tier), settings, options.guardianReviewer === true);
  if (identity.promptCacheKey !== undefined) {
    payload.prompt_cache_key = identity.promptCacheKey;
  }
  normalizeResponsesInputRoles(payload);
  normalizeCodexBuiltinTools(payload);
  if (!("instructions" in payload) || payload.instructions === null) {
    payload.instructions = "";
  }
  normalizeReasoningEffort(payload);
  normalizeStreamOptions(payload);
  if (isResponsesLiteModel(stringValue(payload.model))) {
    await applyResponsesLiteFormat(payload, identity.threadId);
  }
  normalizeReasoningInclude(payload);
  return payload;
}

// Mirrors codex effective_service_tier: a client-supplied tier wins (an explicit
// "default" opts out entirely). When the client is silent the dashboard Fast mode
// asks for "priority"; with Fast mode off the model's own catalog default applies
// (gpt-6-sol and gpt-6-luna default to Fast). Tiers the catalog does not list for
// the model are dropped, except "flex", which Codex always forwards as an API
// request option.
function applyServiceTier(
  payload: JsonObject,
  requested: string | undefined,
  settings: ProxySettings,
  guardianReviewer: boolean,
): void {
  delete payload.service_tier;
  if (guardianReviewer) {
    return;
  }
  const model = stringValue(payload.model);
  const tier = requested ?? (settings.fastMode ? FAST_MODE_SERVICE_TIER : defaultServiceTier(model));
  if (tier === undefined || tier === SERVICE_TIER_DEFAULT_REQUEST_VALUE) {
    return;
  }
  if (tier !== SERVICE_TIER_FLEX) {
    const supported = supportedServiceTiers(model);
    if (supported !== undefined && !supported.includes(tier)) {
      return;
    }
  }
  payload.service_tier = tier;
}

// Codex always asks for encrypted reasoning content so reasoning survives
// store=false across turns, whether or not the request carries a reasoning block.
function normalizeReasoningInclude(payload: JsonObject): void {
  const include = Array.isArray(payload.include) ? payload.include : [];
  const filtered = include.filter((item) => item !== "reasoning.encrypted_content") as JsonValue[];
  filtered.push("reasoning.encrypted_content");
  payload.include = filtered;
}

// "ultra" and "persistent" are codex client-side reasoning levels; the wire value
// depends on the model (see reasoningEffortForRequest).
function normalizeReasoningEffort(payload: JsonObject): void {
  if (!isRecord(payload.reasoning)) {
    return;
  }
  const effort = stringValue(payload.reasoning.effort);
  if (effort === undefined) {
    return;
  }
  payload.reasoning.effort = reasoningEffortForRequest(stringValue(payload.model), effort);
}

function normalizeStreamOptions(payload: JsonObject): void {
  const streamOptions = isRecord(payload.stream_options) ? payload.stream_options : undefined;
  if (streamOptions?.reasoning_summary_delivery === "sequential_cutoff") {
    payload.stream_options = { reasoning_summary_delivery: "sequential_cutoff" };
    return;
  }
  delete payload.stream_options;
}

async function applyResponsesLiteFormat(payload: JsonObject, threadId: string | undefined): Promise<void> {
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
    // Lite-aware clients (Codex itself) already shaped the input.
    dropEmptyInstructions(payload);
    return;
  }
  // Codex rebuilds these prompt-only items on every request and hashes their
  // payload within the thread into stable ids, so retries and resumed sessions
  // keep the same prefix (core/src/client.rs build_responses_request).
  const prefixNamespace = threadId === undefined ? undefined : (await uuidV5(threadId)).replaceAll("-", "");
  const tools = buildResponsesLiteTools(Array.isArray(payload.tools) ? payload.tools : []);
  const additionalTools: JsonObject = { type: "additional_tools", role: "developer", tools };
  if (prefixNamespace !== undefined) {
    additionalTools.id = `at_${await uuidV5(JSON.stringify(tools), prefixNamespace)}`;
  }
  const prefix: JsonValue[] = [additionalTools];
  delete payload.tools;
  const instructions = typeof payload.instructions === "string" ? payload.instructions : "";
  if (instructions !== "") {
    const message: JsonObject = {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: instructions }],
    };
    if (prefixNamespace !== undefined) {
      message.id = `msg_${await uuidV5(instructions, prefixNamespace)}`;
    }
    prefix.push(message);
  }
  // Codex never sends top-level instructions on lite requests: they either moved
  // into the developer message above or were empty to begin with.
  delete payload.instructions;
  input.unshift(...prefix);
}

// Mirrors codex-tools create_tools_json_for_responses_lite: function and custom
// tools are grouped into the "functions" namespace at the position of the first
// such tool, everything else keeps its place, and the whole list travels inside
// the additional_tools item.
function buildResponsesLiteTools(tools: JsonValue[]): JsonValue[] {
  const namespace: JsonObject = { type: "namespace", name: DEFAULT_FUNCTION_NAMESPACE, description: "", tools: [] };
  const namespaceTools: JsonValue[] = [];
  let namespaceIndex: number | undefined;
  const out: JsonValue[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
    }
    const type = stringValue(tool.type);
    if (type === "function" || type === "custom") {
      namespaceTools.push(tool);
    } else if (type === "namespace" && tool.name === DEFAULT_FUNCTION_NAMESPACE) {
      const description = stringValue(tool.description);
      if (description !== undefined) {
        namespace.description = description;
      }
      if (Array.isArray(tool.tools)) {
        namespaceTools.push(...tool.tools);
      }
    } else {
      out.push(tool);
      continue;
    }
    namespaceIndex ??= out.length;
  }
  if (namespaceIndex !== undefined && namespaceTools.length > 0) {
    namespace.tools = namespaceTools;
    out.splice(namespaceIndex, 0, namespace);
  }
  return out;
}

function dropEmptyInstructions(payload: JsonObject): void {
  if (typeof payload.instructions !== "string" || payload.instructions === "") {
    delete payload.instructions;
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
