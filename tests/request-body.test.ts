import assert from "node:assert/strict";
import test from "node:test";
import * as zlib from "node:zlib";

import { readJsonObject, RequestBodyError } from "../src/utils.js";

const body = { model: "gpt-6-astra", input: "hi" };

function request(bytes: Uint8Array | string, encoding?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (encoding !== undefined) {
    headers.set("content-encoding", encoding);
  }
  const body: BodyInit = typeof bytes === "string" ? bytes : new Blob([bytes as BlobPart]);
  return new Request("https://proxy.example/v1/responses", { method: "POST", headers, body });
}

test("plain JSON bodies are parsed", async () => {
  assert.deepEqual(await readJsonObject(request(JSON.stringify(body))), body);
  assert.deepEqual(await readJsonObject(request(JSON.stringify(body), "identity")), body);
});

test("invalid JSON bodies map to 400", async () => {
  await assert.rejects(readJsonObject(request("{")), (error: unknown) => {
    assert.ok(error instanceof RequestBodyError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "invalid_request_body");
    return true;
  });
  await assert.rejects(readJsonObject(request("[1]")), (error: unknown) => {
    assert.ok(error instanceof RequestBodyError);
    assert.equal(error.status, 400);
    return true;
  });
});

test("gzip request bodies are decoded", async () => {
  const compressed = new Uint8Array(zlib.gzipSync(JSON.stringify(body)));
  assert.deepEqual(await readJsonObject(request(compressed, "gzip")), body);
});

test("zstd request bodies are decoded when the runtime supports zstd", {
  skip: typeof zlib.zstdCompressSync !== "function" ? "node:zlib has no zstd on this runtime" : false,
}, async () => {
  const compressed = new Uint8Array(zlib.zstdCompressSync(JSON.stringify(body)));
  assert.deepEqual(await readJsonObject(request(compressed, "zstd")), body);
  assert.deepEqual(await readJsonObject(request(compressed, "ZSTD")), body);
});

test("corrupt compressed bodies map to 400", async () => {
  await assert.rejects(readJsonObject(request(new Uint8Array([1, 2, 3]), "gzip")), (error: unknown) => {
    assert.ok(error instanceof RequestBodyError);
    assert.equal(error.status, 400);
    assert.match(error.message, /failed to decode gzip/);
    return true;
  });
});

test("unknown content encodings map to 415", async () => {
  await assert.rejects(readJsonObject(request("{}", "lzma")), (error: unknown) => {
    assert.ok(error instanceof RequestBodyError);
    assert.equal(error.status, 415);
    assert.equal(error.code, "unsupported_content_encoding");
    return true;
  });
});
