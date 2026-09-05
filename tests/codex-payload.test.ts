import assert from "node:assert/strict";
import test from "node:test";

import { isResponsesLiteModel, prepareCodexPayload } from "../src/codex-payload.js";
import type { ProxySettings } from "../src/settings.js";
import type { JsonObject } from "../src/types.js";
import { uuidV5 } from "../src/utils.js";

const settings: ProxySettings = {
  fastMode: false,
  proxyApiKeys: [],
  serviceTier: "default",
};

const fastSettings: ProxySettings = { ...settings, fastMode: true };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("responses lite models are detected from the codex catalog", () => {
  assert.equal(isResponsesLiteModel("gpt-6-astra"), true);
  assert.equal(isResponsesLiteModel("gpt-5.6-sol"), true);
  assert.equal(isResponsesLiteModel("gpt-5.6-terra"), true);
  assert.equal(isResponsesLiteModel("gpt-5.6-luna"), true);
  assert.equal(isResponsesLiteModel("gpt-5.6"), true);
  assert.equal(isResponsesLiteModel("gpt-daybreak-blue-latest"), true);
  assert.equal(isResponsesLiteModel("codex-auto-review"), true);
  assert.equal(isResponsesLiteModel("gpt-5.5"), false);
  assert.equal(isResponsesLiteModel("gpt-5.4-mini"), false);
  assert.equal(isResponsesLiteModel("gpt-5.60"), false);
  assert.equal(isResponsesLiteModel(undefined), false);
});

test("responses lite payload moves tools and instructions into input", async () => {
  const payload = await prepareCodexPayload(
    {
      model: "gpt-5.6-sol",
      instructions: "be brief",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{ type: "function", name: "get_weather", parameters: { type: "object" } }],
      reasoning: { effort: "high" },
    },
    true,
    settings,
  );

  assert.equal(payload.parallel_tool_calls, false);
  assert.equal("instructions" in payload, false);
  assert.equal("tools" in payload, false);
  assert.deepEqual(payload.reasoning, { effort: "high", context: "all_turns" });
  const input = payload.input as JsonObject[];
  assert.equal(input.length, 3);
  // Codex wraps function/custom tools in the "functions" namespace.
  assert.deepEqual(input[0], {
    type: "additional_tools",
    role: "developer",
    tools: [
      {
        type: "namespace",
        name: "functions",
        description: "",
        tools: [{ type: "function", name: "get_weather", parameters: { type: "object" } }],
      },
    ],
  });
  assert.deepEqual(input[1], {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "be brief" }],
  });
  assert.equal(input[2].type, "message");
});

test("responses lite prefix items get stable ids derived from the thread id", async () => {
  const input = {
    model: "gpt-6-astra",
    instructions: "be brief",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    tools: [{ type: "function", name: "get_weather" }],
  };
  const first = await prepareCodexPayload(input, true, settings, { threadId: "thread-a" });
  const again = await prepareCodexPayload(input, true, settings, { threadId: "thread-a" });
  const other = await prepareCodexPayload(input, true, settings, { threadId: "thread-b" });

  const firstItems = first.input as JsonObject[];
  const additionalToolsId = firstItems[0].id as string;
  const messageId = firstItems[1].id as string;
  assert.match(additionalToolsId, /^at_/);
  assert.match(messageId, /^msg_/);
  assert.match(additionalToolsId.slice(3), UUID_PATTERN);
  assert.match(messageId.slice(4), UUID_PATTERN);
  // Same thread and same prefix content => same ids (codex hashes the JSON of the
  // tools / the instructions text under a uuidv5 namespace derived from the thread).
  const prefixNamespace = (await uuidV5("thread-a")).replaceAll("-", "");
  const tools = (firstItems[0] as JsonObject).tools;
  assert.equal(additionalToolsId, `at_${await uuidV5(JSON.stringify(tools), prefixNamespace)}`);
  assert.equal(messageId, `msg_${await uuidV5("be brief", prefixNamespace)}`);
  assert.deepEqual(again.input, first.input);
  assert.notEqual((other.input as JsonObject[])[0].id, additionalToolsId);
  assert.notEqual((other.input as JsonObject[])[1].id, messageId);
});

test("responses lite payload without tools still sends an empty additional_tools item", async () => {
  const payload = await prepareCodexPayload({ model: "gpt-5.6-sol", input: "hi" }, true, settings);

  const input = payload.input as JsonObject[];
  assert.equal(input.length, 2);
  assert.deepEqual(input[0], { type: "additional_tools", role: "developer", tools: [] });
  assert.equal(input[1].type, "message");
  assert.equal("tools" in payload, false);
});

test("responses lite payload keeps lite-aware client input untouched", async () => {
  const clientInput: JsonObject[] = [
    { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "shell" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
  ];
  const payload = await prepareCodexPayload(
    {
      model: "gpt-5.6-terra",
      instructions: "",
      input: clientInput,
      reasoning: { effort: "max", context: "current_turn" },
    },
    true,
    settings,
  );

  assert.equal(payload.parallel_tool_calls, false);
  assert.equal("instructions" in payload, false);
  assert.deepEqual(payload.input, clientInput);
  assert.deepEqual(payload.reasoning, { effort: "max", context: "current_turn" });
});

test("responses lite payload groups all tools inside additional_tools like codex", async () => {
  const payload = await prepareCodexPayload(
    {
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [
        { type: "web_search_preview" },
        { type: "function", name: "get_weather" },
        { type: "tool_search", tools: [{ type: "function", name: "deferred", defer_loading: true }] },
        { type: "custom", name: "grammar_tool" },
        { type: "namespace", name: "functions", description: "client fns", tools: [{ type: "function", name: "extra" }] },
      ],
    },
    true,
    settings,
  );

  assert.equal("tools" in payload, false);
  const input = payload.input as JsonObject[];
  assert.equal(input[0].type, "additional_tools");
  // The functions namespace lands where the first function/custom tool was and
  // absorbs a client-provided "functions" namespace; hosted tools keep their order.
  assert.deepEqual(input[0].tools, [
    { type: "web_search" },
    {
      type: "namespace",
      name: "functions",
      description: "client fns",
      tools: [
        { type: "function", name: "get_weather" },
        { type: "custom", name: "grammar_tool" },
        { type: "function", name: "extra" },
      ],
    },
    { type: "tool_search", tools: [{ type: "function", name: "deferred", defer_loading: true }] },
  ]);
});

test("responses lite payload always carries reasoning.context and encrypted content include", async () => {
  const payload = await prepareCodexPayload({ model: "gpt-5.6-sol", input: "hi" }, true, settings);

  assert.deepEqual(payload.reasoning, { context: "all_turns" });
  assert.deepEqual(payload.include, ["reasoning.encrypted_content"]);
});

test("ultra reasoning effort follows the codex per-model mapping", async () => {
  const astraPayload = await prepareCodexPayload(
    { model: "gpt-6-astra", input: "hi", reasoning: { effort: "ultra" } },
    true,
    settings,
  );
  const litePayload = await prepareCodexPayload(
    { model: "gpt-5.6-sol", input: "hi", reasoning: { effort: "ultra" } },
    true,
    settings,
  );
  const legacyPayload = await prepareCodexPayload(
    { model: "gpt-5.5", input: "hi", reasoning: { effort: "ultra" } },
    true,
    settings,
  );
  const persistentPayload = await prepareCodexPayload(
    { model: "gpt-6-astra", input: "hi", reasoning: { effort: "persistent" } },
    true,
    settings,
  );

  // gpt-6-astra defines multi_agent_reasoning_effort = xhigh; gpt-5.5 has no
  // "max" level so codex sends its highest supported level instead.
  assert.equal((astraPayload.reasoning as JsonObject).effort, "xhigh");
  assert.equal((litePayload.reasoning as JsonObject).effort, "max");
  assert.equal((legacyPayload.reasoning as JsonObject).effort, "xhigh");
  assert.equal((persistentPayload.reasoning as JsonObject).effort, "disabled");
});

test("encrypted reasoning content is always requested", async () => {
  const withoutReasoning = await prepareCodexPayload({ model: "gpt-5.5", input: "hi" }, true, settings);
  const withInclude = await prepareCodexPayload(
    { model: "gpt-5.5", input: "hi", include: ["reasoning.encrypted_content", "web_search_call.action.sources"] },
    true,
    settings,
  );

  assert.deepEqual(withoutReasoning.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(withInclude.include, ["web_search_call.action.sources", "reasoning.encrypted_content"]);
});

test("service tier prefers the client value and falls back to fast mode", async () => {
  const clientTier = await prepareCodexPayload(
    { model: "gpt-5.6-sol", input: "hi", service_tier: "ultrafast" },
    true,
    settings,
  );
  const clientDefault = await prepareCodexPayload(
    { model: "gpt-5.6-sol", input: "hi", service_tier: "default" },
    true,
    fastSettings,
  );
  const fastFallback = await prepareCodexPayload({ model: "gpt-5.6-sol", input: "hi" }, true, fastSettings);
  const silent = await prepareCodexPayload({ model: "gpt-5.6-sol", input: "hi" }, true, settings);

  assert.equal(clientTier.service_tier, "ultrafast");
  // An explicit "default" opts out of the dashboard Fast mode, like codex drops it.
  assert.equal("service_tier" in clientDefault, false);
  assert.equal(fastFallback.service_tier, "priority");
  assert.equal("service_tier" in silent, false);
});

test("service tier is dropped when the codex catalog does not list it for the model", async () => {
  const unsupportedTier = await prepareCodexPayload(
    { model: "gpt-5.5", input: "hi", service_tier: "ultrafast" },
    true,
    settings,
  );
  const noTiers = await prepareCodexPayload({ model: "gpt-5.4-mini", input: "hi" }, true, fastSettings);
  const unknownModel = await prepareCodexPayload(
    { model: "gpt-9-unknown", input: "hi", service_tier: "ultrafast" },
    true,
    settings,
  );

  assert.equal("service_tier" in unsupportedTier, false);
  assert.equal("service_tier" in noTiers, false);
  // Models outside the catalog cannot be validated, so the client value passes.
  assert.equal(unknownModel.service_tier, "ultrafast");
});

test("prompt cache key from the request identity is applied", async () => {
  const payload = await prepareCodexPayload(
    { model: "gpt-5.5", input: "hi", prompt_cache_key: "client-key" },
    true,
    settings,
    { threadId: "thread", promptCacheKey: "resolved-key" },
  );

  assert.equal(payload.prompt_cache_key, "resolved-key");
});

test("non-lite models keep the existing payload shape", async () => {
  const payload = await prepareCodexPayload(
    {
      model: "gpt-5.5",
      instructions: "be brief",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{ type: "function", name: "get_weather" }],
      reasoning: { effort: "xhigh" },
    },
    true,
    settings,
  );

  assert.equal(payload.parallel_tool_calls, true);
  assert.equal(payload.instructions, "be brief");
  assert.deepEqual(payload.tools, [{ type: "function", name: "get_weather" }]);
  assert.deepEqual(payload.reasoning, { effort: "xhigh" });
  assert.equal((payload.input as JsonObject[]).length, 1);
});

test("responses lite strips image detail from messages and tool outputs", async () => {
  const payload = await prepareCodexPayload(
    {
      model: "gpt-5.6-sol",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,AAA", detail: "original" }],
        },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: [{ type: "input_image", image_url: "data:image/png;base64,BBB", detail: "high" }],
        },
        {
          type: "custom_tool_call_output",
          call_id: "call-2",
          output: [{ type: "input_image", image_url: "data:image/png;base64,CCC", detail: "auto" }],
        },
      ],
    },
    true,
    settings,
  );

  // The additional_tools prefix item is inserted first.
  const input = (payload.input as JsonObject[]).slice(1);
  assert.equal("detail" in ((input[0].content as JsonObject[])[0] as JsonObject), false);
  assert.equal("detail" in ((input[1].output as JsonObject[])[0] as JsonObject), false);
  assert.equal("detail" in ((input[2].output as JsonObject[])[0] as JsonObject), false);
});

test("non-lite payload keeps image detail", async () => {
  const payload = await prepareCodexPayload(
    {
      model: "gpt-5.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,AAA", detail: "original" }],
        },
      ],
    },
    true,
    settings,
  );

  const input = payload.input as JsonObject[];
  assert.equal(((input[0].content as JsonObject[])[0] as JsonObject).detail, "original");
});

test("only supported reasoning summary stream options are preserved", async () => {
  const supported = await prepareCodexPayload(
    {
      model: "gpt-5.5",
      input: "hi",
      stream_options: {
        reasoning_summary_delivery: "sequential_cutoff",
        ignored: true,
      },
    },
    true,
    settings,
  );
  const unsupported = await prepareCodexPayload(
    {
      model: "gpt-5.5",
      input: "hi",
      stream_options: { reasoning_summary_delivery: "unknown" },
    },
    true,
    settings,
  );

  assert.deepEqual(supported.stream_options, { reasoning_summary_delivery: "sequential_cutoff" });
  assert.equal("stream_options" in unsupported, false);
});
