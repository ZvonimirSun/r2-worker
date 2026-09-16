import assert from "node:assert/strict";
import test from "node:test";
import { deploy } from "../scripts/deploy.js";

const settings = {
  bindings: [{ name: "R2", type: "r2_bucket", bucket_name: "online-bucket" }],
  compatibility_date: "2026-09-16",
  compatibility_flags: [],
  usage_model: "standard",
  placement: {},
  tail_consumers: [],
  logpush: false,
};
const accountId = "a".repeat(32);
const token = "test-token";
const apiResponse = (result, status = 200) => Response.json({ success: status === 200, result, errors: [] }, { status });

test("deploy sends only bundled code and leaves online configuration intact", async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return apiResponse(options.method === "PUT" ? {} : settings);
  };
  const result = await deploy({
    accountId, token, request, readBundle: async () => Buffer.from("export default { fetch() {} }"),
  });

  assert.deepEqual(result, { workerName: "r2-worker", bucketName: "online-bucket" });
  assert.deepEqual(calls.map((call) => [new URL(call.url).pathname, call.options.method || "GET"]), [
    [`/client/v4/accounts/${accountId}/workers/scripts/r2-worker/settings`, "GET"],
    [`/client/v4/accounts/${accountId}/workers/scripts/r2-worker/content`, "PUT"],
    [`/client/v4/accounts/${accountId}/workers/scripts/r2-worker/settings`, "GET"],
  ]);
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${token}`);
  const form = calls[1].options.body;
  assert.deepEqual(JSON.parse(await form.get("metadata").text()), { main_module: "index.js" });
  assert.equal(await form.get("index.js").text(), "export default { fetch() {} }");
});

test("deploy refuses to upload without the existing R2 binding", async () => {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    return apiResponse({ ...settings, bindings: [] });
  };
  await assert.rejects(deploy({ accountId, token, request, readBundle: async () => Buffer.from("code") }), /R2 bucket binding/);
  assert.equal(calls.length, 1);
});

test("deploy refuses missing credentials and detects unexpected settings changes", async () => {
  await assert.rejects(deploy({ accountId: "", token: "" }), /CLOUDFLARE_API_TOKEN/);
  let calls = 0;
  const request = async (_url, options) => {
    calls++;
    if (options.method === "PUT") return apiResponse({});
    return apiResponse(calls === 3 ? { ...settings, compatibility_date: "2026-09-17" } : settings);
  };
  await assert.rejects(deploy({
    accountId, token, request, readBundle: async () => Buffer.from("code"),
  }), /settings changed/);
});

test("deploy discovers the sole online Worker without an account ID variable", async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push([new URL(url).pathname, options.method || "GET"]);
    if (url.includes("/accounts?")) return apiResponse([{ id: accountId }]);
    return apiResponse(options.method === "PUT" ? {} : settings);
  };
  const result = await deploy({
    accountId: "", token, request, readBundle: async () => Buffer.from("code"),
  });
  assert.equal(result.bucketName, "online-bucket");
  assert.deepEqual(calls.map(([, method]) => method), ["GET", "GET", "PUT", "GET"]);
});

test("ambiguous online Workers stop before uploading", async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push(options.method || "GET");
    return apiResponse(url.includes("/accounts?") ? [{ id: accountId }, { id: "b".repeat(32) }] : settings);
  };
  await assert.rejects(deploy({
    accountId: "", token, request, readBundle: async () => Buffer.from("code"),
  }), /found 2/);
  assert.deepEqual(calls, ["GET", "GET", "GET"]);
});
