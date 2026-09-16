import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const workerName = "r2-worker";
const apiBase = "https://api.cloudflare.com/client/v4";
const bundleUrl = new URL("../.wrangler/deploy/index.js", import.meta.url);

function preservedSettings(settings) {
  const {
    bindings, compatibility_date, compatibility_flags, usage_model,
    placement, limits, observability, logpush, tail_consumers, cache_options,
  } = settings;
  return {
    bindings, compatibility_date, compatibility_flags, usage_model,
    placement, limits, observability, logpush, tail_consumers, cache_options,
  };
}

function requireR2(settings) {
  if (!Array.isArray(settings?.bindings) ||
      !settings.bindings.some((binding) =>
        binding.name === "R2" && binding.type === "r2_bucket" && binding.bucket_name)) {
    throw new Error("Online worker must already have an R2 bucket binding named R2; deployment stopped.");
  }
}

export async function deploy({
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  token = process.env.CLOUDFLARE_API_TOKEN,
  readBundle = () => readFile(bundleUrl),
  request = fetch,
} = {}) {
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required in the build environment.");
  if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is invalid.");
  }

  async function api(path, { allowNotFound = false, ...options } = {}) {
    const response = await request(`${apiBase}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
    });
    const payload = await response.json();
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok || payload.success !== true) {
      const errors = payload.errors?.map((error) => error.message).join("; ") || response.statusText;
      throw new Error(`Cloudflare API ${response.status}: ${errors}`);
    }
    return payload.result;
  }

  let before;
  if (!accountId) {
    const matches = [];
    for (let page = 1; page <= 100; page++) {
      const accounts = await api(`/accounts?page=${page}&per_page=50`);
      if (!Array.isArray(accounts)) throw new Error("Could not list Cloudflare accounts.");
      for (const account of accounts) {
        const settings = await api(`/accounts/${account.id}/workers/scripts/${workerName}/settings`, {
          allowNotFound: true,
        });
        if (settings?.bindings?.some((binding) =>
          binding.name === "R2" && binding.type === "r2_bucket" && binding.bucket_name)) {
          matches.push({ accountId: account.id, settings });
        }
      }
      if (accounts.length < 50) break;
      if (page === 100) throw new Error("Too many Cloudflare accounts to identify the target safely.");
    }
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one online ${workerName} with an R2 binding; found ${matches.length}.`);
    }
    ({ accountId, settings: before } = matches[0]);
  }

  const workerPath = `/accounts/${accountId}/workers/scripts/${workerName}`;
  before ??= await api(`${workerPath}/settings`);
  requireR2(before);

  const bundle = await readBundle();
  if (!bundle.length) throw new Error("Wrangler bundle is empty; run npm run build first.");

  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify({ main_module: "index.js" })], {
    type: "application/json",
  }));
  form.set("index.js", new Blob([bundle], { type: "application/javascript+module" }), "index.js");
  await api(`${workerPath}/content`, { method: "PUT", body: form });

  const after = await api(`${workerPath}/settings`);
  requireR2(after);
  if (!isDeepStrictEqual(preservedSettings(before), preservedSettings(after))) {
    throw new Error("Online Worker settings changed during content deployment; inspect the dashboard immediately.");
  }
  return { workerName, bucketName: after.bindings.find((binding) => binding.name === "R2").bucket_name };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deploy()
    .then(({ workerName: name }) => console.log(`Updated ${name} code; online settings and R2 binding preserved.`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
