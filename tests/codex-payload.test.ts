import assert from "node:assert/strict";
import test from "node:test";

import { isResponsesLiteModel, prepareCodexPayload } from "../src/codex-payload.js";
import type { ProxySettings } from "../src/settings.js";
import type { JsonObject } from "../src/types.js";

const settings: ProxySettings = {
  fastMode: false,
  identityConfuse: false,
  proxyApiKeys: [],
  serviceTier: "default",
};

test("gpt-5.6 models are detected as responses lite models", () => {
  assert.equal(isResponsesLiteModel("gpt-5.6-sol"), true);
  assert.equal(isResponsesLiteModel("gpt-5.6-terra"), true);
  assert.equal(isResponsesLiteModel("gpt-5.6-luna"), true);
  assert.equal(isResponsesLiteModel("gpt-5.6"), true);
  assert.equal(isResponsesLiteModel("gpt-5.5"), false);
  assert.equal(isResponsesLiteModel("gpt-5.60"), false);
  assert.equal(isResponsesLiteModel(undefined), false);
});

test("responses lite payload moves tools and instructions into input", () => {
  const payload = prepareCodexPayload(
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
  assert.equal(payload.instructions, "");
  assert.equal("tools" in payload, false);
  assert.deepEqual(payload.reasoning, { effort: "high", context: "all_turns" });
  const input = payload.input as JsonObject[];
  assert.equal(input.length, 3);
  assert.equal(input[0].type, "additional_tools");
  assert.equal(input[0].role, "developer");
  assert.deepEqual(input[0].tools, [{ type: "function", name: "get_weather", parameters: { type: "object" } }]);
  assert.deepEqual(input[1], {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "be brief" }],
  });
  assert.equal(input[2].type, "message");
});

test("responses lite payload keeps lite-aware client input untouched", () => {
  const clientInput: JsonObject[] = [
    { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "shell" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
  ];
  const payload = prepareCodexPayload(
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
  assert.deepEqual(payload.input, clientInput);
  assert.deepEqual(payload.reasoning, { effort: "max", context: "current_turn" });
});

test("responses lite payload keeps hosted tools top-level and moves client tools", () => {
  const payload = prepareCodexPayload(
    {
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [
        { type: "web_search_preview" },
        { type: "function", name: "get_weather" },
        { type: "custom", name: "grammar_tool" },
      ],
    },
    true,
    settings,
  );

  assert.deepEqual(payload.tools, [{ type: "web_search" }]);
  const input = payload.input as JsonObject[];
  assert.equal(input[0].type, "additional_tools");
  assert.deepEqual(input[0].tools, [
    { type: "function", name: "get_weather" },
    { type: "custom", name: "grammar_tool" },
  ]);
});

test("responses lite payload always carries reasoning.context and encrypted content include", () => {
  const payload = prepareCodexPayload({ model: "gpt-5.6-sol", input: "hi" }, true, settings);

  assert.deepEqual(payload.reasoning, { context: "all_turns" });
  assert.deepEqual(payload.include, ["reasoning.encrypted_content"]);
});

test("ultra reasoning effort maps to max on the wire", () => {
  const litePayload = prepareCodexPayload(
    { model: "gpt-5.6-sol", input: "hi", reasoning: { effort: "ultra" } },
    true,
    settings,
  );
  const legacyPayload = prepareCodexPayload(
    { model: "gpt-5.5", input: "hi", reasoning: { effort: "ultra" } },
    true,
    settings,
  );

  assert.equal((litePayload.reasoning as JsonObject).effort, "max");
  assert.equal((legacyPayload.reasoning as JsonObject).effort, "max");
});

test("non-lite models keep the existing payload shape", () => {
  const payload = prepareCodexPayload(
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

test("responses lite strips image detail from messages and tool outputs", () => {
  const payload = prepareCodexPayload(
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

  const input = payload.input as JsonObject[];
  assert.equal("detail" in ((input[0].content as JsonObject[])[0] as JsonObject), false);
  assert.equal("detail" in ((input[1].output as JsonObject[])[0] as JsonObject), false);
  assert.equal("detail" in ((input[2].output as JsonObject[])[0] as JsonObject), false);
});

test("non-lite payload keeps image detail", () => {
  const payload = prepareCodexPayload(
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

test("only supported reasoning summary stream options are preserved", () => {
  const supported = prepareCodexPayload(
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
  const unsupported = prepareCodexPayload(
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
