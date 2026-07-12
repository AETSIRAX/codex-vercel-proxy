import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexEndpointUrl,
  buildCodexRequestHeaders,
  resolveCodexJsonPostEndpoint,
} from "../src/codex-endpoint.js";

test("codex extension routes resolve to their upstream paths", () => {
  assert.equal(resolveCodexJsonPostEndpoint("/v1/alpha/search", "POST"), "alpha/search");
  assert.equal(resolveCodexJsonPostEndpoint("/v1/responses/compact", "POST"), "responses/compact");
  assert.equal(resolveCodexJsonPostEndpoint("/v1/images/generations", "POST"), "images/generations");
  assert.equal(resolveCodexJsonPostEndpoint("/v1/images/edits", "POST"), "images/edits");
  assert.equal(
    resolveCodexJsonPostEndpoint("/v1/memories/trace_summarize", "POST"),
    "memories/trace_summarize",
  );
  assert.equal(resolveCodexJsonPostEndpoint("/v1/alpha/search", "GET"), undefined);
});

test("codex endpoint URL appends the supported path and client version", () => {
  const url = buildCodexEndpointUrl("models", new URLSearchParams({ client_version: "0.144.1" }));

  assert.equal(url.toString(), "https://chatgpt.com/backend-api/codex/models?client_version=0.144.1");
});

test("codex endpoint headers forward attestation and conditional model headers", () => {
  const request = new Request("https://proxy.example/v1/models?client_version=0.144.1", {
    headers: {
      "if-none-match": "etag-value",
      "x-oai-attestation": "attestation-value",
      "x-openai-memgen-request": "true",
      "x-openai-subagent": "memory_consolidation",
      "x-codex-installation-id": "installation-value",
      version: "0.144.2",
    },
  });
  const headers = buildCodexRequestHeaders(
    request,
    {},
    {
      id: "credential-1",
      label: "primary",
      token: "upstream-token",
      accountId: "account-1",
    },
    "application/json",
    false,
  );

  assert.equal(headers.get("authorization"), "Bearer upstream-token");
  assert.equal(headers.get("chatgpt-account-id"), "account-1");
  assert.equal(headers.get("if-none-match"), "etag-value");
  assert.equal(headers.get("x-oai-attestation"), "attestation-value");
  assert.equal(headers.get("x-openai-memgen-request"), "true");
  assert.equal(headers.get("x-openai-subagent"), "memory_consolidation");
  assert.equal(headers.get("x-codex-installation-id"), "installation-value");
  assert.equal(headers.get("version"), "0.144.2");
  assert.equal(headers.has("content-type"), false);
});

test("codex JSON endpoint headers apply the default CLI version", () => {
  const headers = buildCodexRequestHeaders(
    new Request("https://proxy.example/v1/alpha/search"),
    {},
    { id: "credential-1", label: "primary", token: "upstream-token" },
    "application/json",
    true,
  );

  assert.equal(headers.get("version"), "0.144.1");
  assert.equal(headers.get("content-type"), "application/json");
});
