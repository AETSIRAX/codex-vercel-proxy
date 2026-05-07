import {
  collectOutputItem,
  fetchCodexWithRotation,
  extractResponseText,
  patchCompletedOutput,
  prepareCodexPayload,
  responseObject,
  type OutputItem,
} from "./codex.js";
import { credentialManager, scheduleCredentialRateLimitUpdate } from "./credential-manager.js";
import { configuredModels, type AppEnv } from "./env.js";
import { encodeSseData, parseSseJson, readSseData } from "./sse.js";
import type { JsonObject, JsonValue, SelectedCredential } from "./types.js";
import { createUsageContext, extractTokenUsage, scheduleUsageRecord, type UsageContext } from "./usage.js";
import { contentStringValue, errorResponse, isRecord, jsonResponse, normalizeErrorMessage, stringValue } from "./utils.js";

export async function proxyChatCompletions(request: Request, env: AppEnv, input: JsonObject): Promise<Response> {
  const wantsStream = input.stream === true;
  const originalToolNameMap = buildShortNameMap(functionToolNames(input.tools));
  const responsesPayload = prepareCodexPayload(chatToResponses(input, originalToolNameMap, env), true);
  const modelName = stringValue(responsesPayload.model) ?? "unknown";
  const usageContext = createUsageContext(request, {
    endpoint: "/v1/chat/completions",
    model: modelName,
    stream: wantsStream,
  });
  const upstream = await fetchCodexWithRotation(request, env, responsesPayload, true);
  if (upstream instanceof Response) {
    scheduleUsageRecord(env, usageContext, {
      statusCode: upstream.status,
      errorCode: upstream.status === 503 ? "credential_unavailable" : "upstream_error",
    });
    return upstream;
  }
  if (wantsStream) {
    return streamChat(upstream.response, modelName, originalToolNameMap, env, upstream.credential, usageContext);
  }
  if (!upstream.response.body) {
    await credentialManager(env).reportResult(upstream.credential.id, {
      ok: false,
      status: 502,
      message: "upstream response body is empty",
    });
    scheduleUsageRecord(env, usageContext, {
      credential: upstream.credential,
      statusCode: 502,
      errorCode: "bad_upstream_response",
    });
    return errorResponse(502, "upstream response body is empty", "bad_upstream_response");
  }
  const outputItems: OutputItem[] = [];
  let completed: JsonObject | undefined;
  try {
    for await (const event of readSseData(upstream.response.body)) {
      const parsed = parseSseJson(event.data);
      if (parsed) {
        collectOutputItem(parsed, outputItems);
      }
      if (parsed?.type === "response.completed") {
        completed = patchCompletedOutput(parsed, outputItems);
        break;
      }
    }
  } catch (error) {
    await credentialManager(env).reportResult(upstream.credential.id, {
      ok: false,
      status: 502,
      message: normalizeErrorMessage(error),
    });
    scheduleUsageRecord(env, usageContext, {
      credential: upstream.credential,
      statusCode: 502,
      errorCode: "bad_upstream_response",
    });
    return errorResponse(502, normalizeErrorMessage(error), "bad_upstream_response");
  }
  if (!completed) {
    await credentialManager(env).reportResult(upstream.credential.id, {
      ok: false,
      status: 502,
      message: "upstream stream ended before response.completed",
    });
    scheduleUsageRecord(env, usageContext, {
      credential: upstream.credential,
      statusCode: 502,
      errorCode: "bad_upstream_response",
    });
    return errorResponse(502, "upstream stream ended before response.completed", "bad_upstream_response");
  }
  const responseValue = responseObject(completed);
  scheduleUsageRecord(env, usageContext, {
    credential: upstream.credential,
    response: responseValue,
    statusCode: upstream.response.status,
  });
  scheduleCredentialRateLimitUpdate(env, upstream.credential);
  return jsonResponse(responseToChat(responseValue, modelName, originalToolNameMap));
}

function chatToResponses(input: JsonObject, originalToolNameMap: Map<string, string>, env: AppEnv): JsonObject {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const responseInput: JsonValue[] = [];

  for (const raw of messages) {
    if (!isRecord(raw)) {
      continue;
    }
    const role = stringValue(raw.role) ?? "user";
    if (role === "tool") {
      responseInput.push({
        type: "function_call_output",
        call_id: stringValue(raw.tool_call_id) ?? "",
        output: normalizeContentText(raw.content),
      });
      continue;
    }

    const content = normalizeMessageContent(raw.content, role);
    const message: JsonObject = {
      type: "message",
      role: role === "system" ? "developer" : role,
      content,
    };
    if (role !== "assistant" || content.length > 0) {
      responseInput.push(message);
    }
    if (role === "assistant") {
      appendAssistantToolCalls(raw, responseInput, originalToolNameMap);
    }
  }

  const payload: JsonObject = {
    model: stringValue(input.model) ?? configuredModels(env)[0] ?? "gpt-5.5",
    input: responseInput,
    instructions: "",
    stream: input.stream === true,
    reasoning: {
      effort: stringValue(input.reasoning_effort) ?? "medium",
      summary: "auto",
    },
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    store: false,
  };
  applyTextFormat(input, payload);
  copyJsonField(input, payload, "prompt_cache_key");
  const tools = convertChatTools(input.tools, originalToolNameMap);
  if (tools.length > 0) {
    payload.tools = tools;
  }
  const toolChoice = convertToolChoice(input.tool_choice, originalToolNameMap);
  if (toolChoice !== undefined) {
    payload.tool_choice = toolChoice;
  }
  return payload;
}

function normalizeContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) {
      continue;
    }
    const text = contentStringValue(part.text);
    if (text !== undefined) {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

function normalizeMessageContent(content: unknown, role: string): JsonObject[] {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: textType, text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: JsonObject[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part !== "") {
        parts.push({ type: textType, text: part });
      }
      continue;
    }
    if (!isRecord(part)) {
      continue;
    }
    const type = stringValue(part.type);
    if (type === "text") {
      const text = contentStringValue(part.text);
      if (text !== undefined) {
        parts.push({ type: textType, text });
      }
      continue;
    }
    if (role === "user" && type === "image_url") {
      const imageUrl = imageUrlValue(part);
      if (imageUrl !== undefined) {
        parts.push({ type: "input_image", image_url: imageUrl });
      }
      continue;
    }
    if (role === "user" && type === "file") {
      const file = isRecord(part.file) ? part.file : undefined;
      const fileData = stringValue(file?.file_data);
      if (fileData !== undefined) {
        const filePart: JsonObject = { type: "input_file", file_data: fileData };
        const filename = stringValue(file?.filename);
        if (filename !== undefined) {
          filePart.filename = filename;
        }
        parts.push(filePart);
      }
    }
  }
  return parts;
}

function imageUrlValue(part: Record<string, unknown>): string | undefined {
  const imageUrl = part.image_url;
  if (typeof imageUrl === "string") {
    return stringValue(imageUrl);
  }
  if (isRecord(imageUrl)) {
    return stringValue(imageUrl.url);
  }
  return undefined;
}

function appendAssistantToolCalls(
  message: Record<string, unknown>,
  responseInput: JsonValue[],
  nameMap: Map<string, string>,
): void {
  if (!Array.isArray(message.tool_calls)) {
    return;
  }
  for (const toolCall of message.tool_calls) {
    if (!isRecord(toolCall) || stringValue(toolCall.type) !== "function" || !isRecord(toolCall.function)) {
      continue;
    }
    const name = stringValue(toolCall.function.name) ?? "";
    responseInput.push({
      type: "function_call",
      call_id: stringValue(toolCall.id) ?? "",
      name: nameMap.get(name) ?? shortenNameIfNeeded(name),
      arguments: contentStringValue(toolCall.function.arguments) ?? "",
    });
  }
}

function functionToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  const names: string[] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || stringValue(tool.type) !== "function" || !isRecord(tool.function)) {
      continue;
    }
    const name = stringValue(tool.function.name);
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

function convertChatTools(tools: unknown, nameMap: Map<string, string>): JsonValue[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  const out: JsonValue[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
    }
    const type = stringValue(tool.type);
    if (type !== undefined && type !== "function") {
      out.push(structuredClone(tool) as JsonObject);
      continue;
    }
    if (type !== "function" || !isRecord(tool.function)) {
      continue;
    }
    const item: JsonObject = { type: "function" };
    const name = stringValue(tool.function.name);
    if (name !== undefined) {
      item.name = nameMap.get(name) ?? shortenNameIfNeeded(name);
    }
    copyJsonField(tool.function, item, "description");
    copyJsonField(tool.function, item, "parameters");
    copyJsonField(tool.function, item, "strict");
    out.push(item);
  }
  return out;
}

function convertToolChoice(toolChoice: unknown, nameMap: Map<string, string>): JsonValue | undefined {
  if (typeof toolChoice === "string") {
    return toolChoice;
  }
  if (!isRecord(toolChoice)) {
    return undefined;
  }
  const type = stringValue(toolChoice.type);
  if (type === "function") {
    const choice: JsonObject = { type: "function" };
    const source = isRecord(toolChoice.function) ? toolChoice.function : toolChoice;
    const name = stringValue(source.name);
    if (name !== undefined) {
      choice.name = nameMap.get(name) ?? shortenNameIfNeeded(name);
    }
    return choice;
  }
  if (type !== undefined) {
    return structuredClone(toolChoice) as JsonObject;
  }
  return undefined;
}

function applyTextFormat(input: JsonObject, payload: JsonObject): void {
  const text = isRecord(input.text) ? input.text : undefined;
  const responseFormat = isRecord(input.response_format) ? input.response_format : undefined;
  const textOut: JsonObject = {};

  if (responseFormat) {
    const type = stringValue(responseFormat.type);
    if (type === "text") {
      textOut.format = { type: "text" };
    } else if (type === "json_schema" && isRecord(responseFormat.json_schema)) {
      const format: JsonObject = { type: "json_schema" };
      copyJsonField(responseFormat.json_schema, format, "name");
      copyJsonField(responseFormat.json_schema, format, "strict");
      copyJsonField(responseFormat.json_schema, format, "schema");
      textOut.format = format;
    }
  }

  const verbosity = stringValue(text?.verbosity);
  if (verbosity !== undefined) {
    textOut.verbosity = verbosity;
  }
  if (Object.keys(textOut).length > 0) {
    payload.text = textOut;
  }
}

function copyJsonField(from: Record<string, unknown>, to: JsonObject, key: string): void {
  if (!(key in from)) {
    return;
  }
  to[key] = structuredClone(from[key]) as JsonValue;
}

function shortenNameIfNeeded(name: string): string {
  const limit = 64;
  if (name.length <= limit) {
    return name;
  }
  if (name.startsWith("mcp__")) {
    const index = name.lastIndexOf("__");
    if (index > 0) {
      const candidate = `mcp__${name.slice(index + 2)}`;
      return candidate.length > limit ? candidate.slice(0, limit) : candidate;
    }
  }
  return name.slice(0, limit);
}

function buildShortNameMap(names: string[]): Map<string, string> {
  const limit = 64;
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const name of names) {
    let candidate = shortenNameIfNeeded(name);
    if (used.has(candidate)) {
      const base = candidate;
      for (let index = 1; ; index += 1) {
        const suffix = `_${index}`;
        candidate = `${base.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
        if (!used.has(candidate)) {
          break;
        }
      }
    }
    used.add(candidate);
    out.set(name, candidate);
  }
  return out;
}

function responseToChat(response: JsonValue, model: string, nameMap: Map<string, string>): JsonObject {
  const now = Math.floor(Date.now() / 1000);
  const responseRecord = isRecord(response) ? response : {};
  const usage = extractTokenUsage(response);
  const output = chatOutputFromResponse(response, nameMap);
  const message: JsonObject = {
    role: "assistant",
    content: output.content !== "" ? output.content : output.toolCalls.length > 0 ? null : "",
  };
  if (output.reasoning !== "") {
    message.reasoning_content = output.reasoning;
  }
  if (output.toolCalls.length > 0) {
    message.tool_calls = output.toolCalls as JsonValue;
  }
  const usageOut: JsonObject = {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
  if (usage.hasCachedTokens) {
    usageOut.prompt_tokens_details = { cached_tokens: usage.cachedTokens };
  }
  if (usage.hasReasoningTokens) {
    usageOut.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens };
  }
  return {
    id: stringValue(responseRecord.id) ?? `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: now,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: output.toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: usageOut,
  };
}

interface ChatOutput {
  content: string;
  reasoning: string;
  toolCalls: JsonObject[];
}

function chatOutputFromResponse(response: JsonValue, nameMap: Map<string, string>): ChatOutput {
  const out: ChatOutput = { content: "", reasoning: "", toolCalls: [] };
  if (!isRecord(response)) {
    return out;
  }
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    const type = stringValue(item.type);
    if (type === "message") {
      out.content += messageOutputText(item);
      continue;
    }
    if (type === "reasoning") {
      out.reasoning += reasoningSummaryText(item);
      continue;
    }
    if (type === "function_call") {
      out.toolCalls.push(toolCallFromCodexItem(item, out.toolCalls.length, nameMap));
    }
  }
  return out;
}

function messageOutputText(item: Record<string, unknown>): string {
  if (!Array.isArray(item.content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of item.content) {
    if (!isRecord(part)) {
      continue;
    }
    const type = stringValue(part.type);
    const text = contentStringValue(part.text);
    if (text !== undefined && (type === "output_text" || type === "text")) {
      parts.push(text);
    }
  }
  return parts.join("");
}

function reasoningSummaryText(item: Record<string, unknown>): string {
  if (!Array.isArray(item.summary)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of item.summary) {
    if (!isRecord(part)) {
      continue;
    }
    const text = contentStringValue(part.text);
    if (text !== undefined) {
      parts.push(text);
    }
  }
  return parts.join("");
}

function toolCallFromCodexItem(item: Record<string, unknown>, index: number, nameMap: Map<string, string>): JsonObject {
  const callId = stringValue(item.call_id) ?? stringValue(item.id) ?? `call_${crypto.randomUUID()}`;
  const name = restoreToolName(contentStringValue(item.name) ?? "", nameMap);
  return {
    index,
    id: callId,
    type: "function",
    function: {
      name,
      arguments: contentStringValue(item.arguments) ?? "",
    },
  };
}

function restoreToolName(name: string, nameMap: Map<string, string>): string {
  for (const [original, shortened] of nameMap) {
    if (shortened === name) {
      return original;
    }
  }
  return name;
}

function streamChat(
  response: Response,
  model: JsonValue | undefined,
  nameMap: Map<string, string>,
  env: AppEnv,
  credential: SelectedCredential,
  usageContext: UsageContext,
): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache");
  headers.delete("content-length");
  const modelName = typeof model === "string" ? model : "unknown";
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (!response.body) {
        await credentialManager(env).reportResult(credential.id, {
          ok: false,
          status: 502,
          message: "upstream response body is empty",
        });
        scheduleUsageRecord(env, usageContext, {
          credential,
          statusCode: 502,
          errorCode: "bad_upstream_response",
        });
        controller.error(new Error("upstream response body is empty"));
        return;
      }
      let emittedContent = false;
      const outputItems: OutputItem[] = [];
      let functionCallIndex = -1;
      let receivedArgumentsDelta = false;
      let completedSeen = false;
      const announcedToolCalls = new Set<string>();
      controller.enqueue(
        encodeSseData({
          id,
          object: "chat.completion.chunk",
          created,
          model: modelName,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }),
      );
      try {
        for await (const event of readSseData(response.body)) {
          const parsed = parseSseJson(event.data);
          if (!parsed) {
            continue;
          }
          collectOutputItem(parsed, outputItems);
          if (parsed.type === "response.reasoning_summary_text.delta") {
            const delta = contentStringValue(parsed.delta);
            if (delta !== undefined) {
              controller.enqueue(encodeSseData(chatDelta(id, created, modelName, { reasoning_content: delta }, null)));
            }
            continue;
          }
          if (parsed.type === "response.output_text.delta") {
            const delta = contentStringValue(parsed.delta);
            if (delta !== undefined && delta !== "") {
              emittedContent = true;
              controller.enqueue(encodeSseData(chatDelta(id, created, modelName, { content: delta }, null)));
            }
            continue;
          }
          if (parsed.type === "response.output_item.added") {
            const item = isRecord(parsed.item) ? parsed.item : undefined;
            if (!item || item.type !== "function_call") {
              continue;
            }
            functionCallIndex += 1;
            receivedArgumentsDelta = false;
            const callId = stringValue(item.call_id) ?? stringValue(item.id) ?? "";
            if (callId !== "") {
              announcedToolCalls.add(callId);
            }
            controller.enqueue(
              encodeSseData(
                chatDelta(
                  id,
                  created,
                  modelName,
                  {
                    tool_calls: [
                      {
                        index: functionCallIndex,
                        id: callId,
                        type: "function",
                        function: {
                          name: restoreToolName(contentStringValue(item.name) ?? "", nameMap),
                          arguments: "",
                        },
                      },
                    ],
                  },
                  null,
                ),
              ),
            );
            continue;
          }
          if (parsed.type === "response.function_call_arguments.delta") {
            receivedArgumentsDelta = true;
            controller.enqueue(
              encodeSseData(
                chatDelta(
                  id,
                  created,
                  modelName,
                  {
                    tool_calls: [
                      {
                        index: Math.max(functionCallIndex, 0),
                        function: { arguments: contentStringValue(parsed.delta) ?? "" },
                      },
                    ],
                  },
                  null,
                ),
              ),
            );
            continue;
          }
          if (parsed.type === "response.function_call_arguments.done") {
            if (receivedArgumentsDelta) {
              continue;
            }
            controller.enqueue(
              encodeSseData(
                chatDelta(
                  id,
                  created,
                  modelName,
                  {
                    tool_calls: [
                      {
                        index: Math.max(functionCallIndex, 0),
                        function: { arguments: contentStringValue(parsed.arguments) ?? "" },
                      },
                    ],
                  },
                  null,
                ),
              ),
            );
            continue;
          }
          if (parsed.type === "response.output_item.done") {
            const item = isRecord(parsed.item) ? parsed.item : undefined;
            if (!item || item.type !== "function_call") {
              continue;
            }
            const callId = stringValue(item.call_id) ?? stringValue(item.id) ?? "";
            if (callId !== "" && announcedToolCalls.has(callId)) {
              announcedToolCalls.delete(callId);
              continue;
            }
            functionCallIndex += 1;
            controller.enqueue(
              encodeSseData(
                chatDelta(
                  id,
                  created,
                  modelName,
                  {
                    tool_calls: [
                      {
                        index: functionCallIndex,
                        id: callId,
                        type: "function",
                        function: {
                          name: restoreToolName(contentStringValue(item.name) ?? "", nameMap),
                          arguments: contentStringValue(item.arguments) ?? "",
                        },
                      },
                    ],
                  },
                  null,
                ),
              ),
            );
            continue;
          }
          if (parsed.type === "response.completed") {
            const completed = patchCompletedOutput(parsed, outputItems);
            completedSeen = true;
            scheduleUsageRecord(env, usageContext, {
              credential,
              response: responseObject(completed),
              statusCode: response.status,
            });
            scheduleCredentialRateLimitUpdate(env, credential);
            if (!emittedContent) {
              const text = extractResponseText(responseObject(completed));
              if (text !== "") {
                controller.enqueue(encodeSseData(chatDelta(id, created, modelName, { content: text }, null)));
              }
            }
            controller.enqueue(
              encodeSseData(chatDelta(id, created, modelName, {}, functionCallIndex >= 0 ? "tool_calls" : "stop")),
            );
            controller.enqueue(encodeSseData("[DONE]"));
            break;
          }
        }
      } catch (error) {
        await credentialManager(env).reportResult(credential.id, {
          ok: false,
          status: 502,
          message: normalizeErrorMessage(error),
        });
        scheduleUsageRecord(env, usageContext, {
          credential,
          statusCode: 502,
          errorCode: "bad_upstream_response",
        });
        controller.error(error);
        return;
      }
      if (!completedSeen) {
        await credentialManager(env).reportResult(credential.id, {
          ok: false,
          status: 502,
          message: "upstream stream ended before response.completed",
        });
        scheduleUsageRecord(env, usageContext, {
          credential,
          statusCode: 502,
          errorCode: "bad_upstream_response",
        });
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

function chatDelta(
  id: string,
  created: number,
  model: string,
  delta: JsonObject,
  finishReason: string | null,
): JsonObject {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}
