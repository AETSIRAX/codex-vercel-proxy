import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexEndpointUrl,
  buildCodexRequestHeaders,
  buildCodexRoutingHint,
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
  const url = buildCodexEndpointUrl("models", new URLSearchParams({ client_version: "0.153.4" }));

  assert.equal(url.toString(), "https://chatgpt.com/backend-api/codex/models?client_version=0.153.4");
});

test("codex endpoint headers forward client identity, attestation and conditional model headers", () => {
  const request = new Request("https://proxy.example/v1/models?client_version=0.153.4", {
    headers: {
      "if-none-match": "etag-value",
      "x-oai-attestation": "attestation-value",
      "x-openai-memgen-request": "true",
      "x-openai-subagent": "memory_consolidation",
      "x-codex-installation-id": "installation-value",
      "x-codex-routing-hint": "model=gpt-6-astra;tier=priority",
      "user-agent": "codex_work_desktop/0.153.4",
      version: "0.153.4",
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
  assert.equal(headers.get("x-codex-routing-hint"), "model=gpt-6-astra;tier=priority");
  assert.equal(headers.get("user-agent"), "codex_work_desktop/0.153.4");
  assert.equal(headers.get("version"), "0.153.4");
  assert.equal(headers.has("content-type"), false);
  assert.equal(headers.has("x-openai-fedramp"), false);
});

test("codex endpoint headers flag fedramp accounts the way Codex does", () => {
  const headers = buildCodexRequestHeaders(
    new Request("https://proxy.example/v1/alpha/search"),
    {},
    { id: "credential-1", label: "primary", token: "upstream-token", accountId: "account-1", fedramp: true },
    "application/json",
    true,
  );

  assert.equal(headers.get("x-openai-fedramp"), "true");
});

test("routing hint carries the model and the service tier when present", () => {
  assert.equal(buildCodexRoutingHint("gpt-6-astra", undefined), "model=gpt-6-astra");
  assert.equal(buildCodexRoutingHint("gpt-5.6-sol", "priority"), "model=gpt-5.6-sol;tier=priority");
  assert.equal(buildCodexRoutingHint(undefined, "priority"), undefined);
});

test("codex JSON endpoint headers apply the verified default client identity", () => {
  const headers = buildCodexRequestHeaders(
    new Request("https://proxy.example/v1/alpha/search"),
    {},
    { id: "credential-1", label: "primary", token: "upstream-token" },
    "application/json",
    true,
  );

  // Current Codex clients identify themselves through User-Agent only.
  assert.equal(headers.has("version"), false);
  assert.equal(headers.get("user-agent"), "codex_cli_rs/0.153.4");
  assert.equal(headers.get("content-type"), "application/json");
});

test("codex endpoint headers use deployment identity when the client omits it", () => {
  const headers = buildCodexRequestHeaders(
    new Request("https://proxy.example/v1/alpha/search"),
    {
      CODEX_CLI_VERSION: "0.147.0",
    },
    { id: "credential-1", label: "primary", token: "upstream-token" },
    "application/json",
    true,
  );

  assert.equal(headers.has("version"), false);
  assert.equal(headers.get("user-agent"), "codex_cli_rs/0.147.0");
});

test("codex client identity takes precedence over deployment defaults", () => {
  const headers = buildCodexRequestHeaders(
    new Request("https://proxy.example/v1/alpha/search", {
      headers: {
        "user-agent": "codex_work_desktop/0.148.0",
        version: "0.148.0",
      },
    }),
    {
      CODEX_CLI_VERSION: "0.147.0",
    },
    { id: "credential-1", label: "primary", token: "upstream-token" },
    "application/json",
    true,
  );

  assert.equal(headers.get("version"), "0.148.0");
  assert.equal(headers.get("user-agent"), "codex_work_desktop/0.148.0");
});
