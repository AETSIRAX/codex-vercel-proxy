import assert from "node:assert/strict";
import test from "node:test";

import { resolveChatVerbosity } from "../src/chat-payload.js";

test("chat top-level verbosity takes precedence", () => {
  const verbosity = resolveChatVerbosity({ verbosity: "high", text: { verbosity: "low" } });

  assert.equal(verbosity, "high");
});

test("responses-style text verbosity remains supported for chat clients", () => {
  const verbosity = resolveChatVerbosity({ text: { verbosity: "medium" } });

  assert.equal(verbosity, "medium");
});
