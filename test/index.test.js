import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const calls = [];
const object = {
  body: "hello",
  size: 5,
  httpEtag: '"etag"',
  uploaded: new Date("2026-01-01T00:00:00Z"),
  writeHttpMetadata(headers) {
    headers.set("Content-Type", "text/plain");
  },
};
const env = {
  R2: {
    async get(key) {
      calls.push(["get", key]);
      return key === "folder/a b.txt" ? object : null;
    },
    async head(key) {
      calls.push(["head", key]);
      return key === "folder/a b.txt" ? object : null;
    },
  },
};
const request = (path, method = "GET") => new Request(`https://files.example${path}`, { method });

test("GET streams a matching key and exposes object metadata", async () => {
  calls.length = 0;
  const response = await worker.fetch(request("/folder/a%20b.txt?ignored=yes"), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "hello");
  assert.deepEqual(calls, [["get", "folder/a b.txt"]]);
  assert.equal(response.headers.get("Content-Type"), "text/plain");
  assert.equal(response.headers.get("ETag"), '"etag"');
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
});

test("HEAD uses metadata-only R2 read", async () => {
  calls.length = 0;
  const response = await worker.fetch(request("/folder/a%20b.txt", "HEAD"), env);
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  assert.equal(response.headers.get("Content-Length"), "5");
  assert.deepEqual(calls, [["head", "folder/a b.txt"]]);
});

test("preflight and rejected requests do not read R2", async () => {
  calls.length = 0;
  const preflight = await worker.fetch(request("/anything", "OPTIONS"), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Methods"), "GET, HEAD, OPTIONS");
  const rejected = await worker.fetch(request("/anything", "PUT"), env);
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get("Allow"), "GET, HEAD, OPTIONS");
  assert.deepEqual(calls, []);
});

test("missing keys and binding return CORS errors", async () => {
  for (const [path, binding, status] of [
    ["/missing", env, 404],
    ["/", env, 404],
    ["/folder/a%20b.txt", {}, 503],
    ["/%GG", env, 400],
  ]) {
    const response = await worker.fetch(request(path), binding);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  }
});

test("successful GET is cached at the edge with a longer TTL than the browser", async () => {
  const previousCache = globalThis.caches;
  const entries = new Map();
  const pending = [];
  globalThis.caches = {
    default: {
      async match(key) {
        return entries.get(key.url)?.clone();
      },
      async put(key, response) {
        const stored = response.clone();
        stored.headers.set("Age", "7200");
        entries.set(key.url, stored);
      },
    },
  };
  const ctx = { waitUntil(promise) { pending.push(promise); } };

  try {
    calls.length = 0;
    const path = "/folder/a%20b.txt?t=1";
    const first = await worker.fetch(request(path), env, ctx);
    assert.equal(first.headers.get("Cache-Control"), "public, max-age=3600");
    assert.equal(await first.text(), "hello");
    await Promise.all(pending);
    assert.equal(entries.get(`https://files.example${path}`).headers.get("Cache-Control"), "public, max-age=2592000");

    const second = await worker.fetch(request(path), env, ctx);
    assert.equal(await second.text(), "hello");
    assert.equal(second.headers.get("Cache-Control"), "public, max-age=3600");
    assert.equal(second.headers.get("Age"), null);
    const head = await worker.fetch(request(path, "HEAD"), env, ctx);
    assert.equal(head.status, 200);
    assert.equal(head.body, null);
    assert.deepEqual(calls, [["get", "folder/a b.txt"]]);

    await worker.fetch(request("/folder/a%20b.txt?t=2"), env, ctx);
    await Promise.all(pending);
    assert.equal(entries.size, 2);
    assert.deepEqual(calls, [["get", "folder/a b.txt"], ["get", "folder/a b.txt"]]);

    await worker.fetch(request("/missing"), env, ctx);
    assert.equal(entries.size, 2);
  } finally {
    if (previousCache === undefined) delete globalThis.caches;
    else globalThis.caches = previousCache;
  }
});
