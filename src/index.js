const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "Content-Length, Content-Type, Content-Disposition, ETag, Last-Modified",
  "Access-Control-Max-Age": "86400",
};
const browserCacheControl = "public, max-age=3600";
const edgeCacheControl = "public, max-age=2592000";

function respond(body, status, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { ...corsHeaders, ...extraHeaders },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return respond(null, 204);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return respond("Method Not Allowed", 405, { Allow: "GET, HEAD, OPTIONS" });
    }

    let key;
    let url;
    try {
      url = new URL(request.url);
      key = decodeURIComponent(url.pathname.slice(1));
    } catch {
      return respond("Bad Request", 400);
    }
    if (!key) return respond("Not Found", 404);
    if (!env.R2) return respond("R2 binding is not configured", 503);

    // The query does not affect the R2 key, but can version the cached URL.
    const cache = globalThis.caches?.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    if (cache) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set("Cache-Control", browserCacheControl);
        headers.delete("Age");
        return new Response(request.method === "HEAD" ? null : cached.body, {
          status: cached.status,
          headers,
        });
      }
    }

    const object = request.method === "HEAD"
      ? await env.R2.head(key)
      : await env.R2.get(key);
    if (!object) return respond("Not Found", 404);

    const headers = new Headers(corsHeaders);
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set("Content-Length", String(object.size));
    headers.set("Last-Modified", object.uploaded.toUTCString());
    headers.set("Cache-Control", browserCacheControl);

    const response = new Response(request.method === "HEAD" ? null : object.body, {
      status: 200,
      headers,
    });
    if (cache && request.method === "GET") {
      const edgeHeaders = new Headers(headers);
      edgeHeaders.set("Cache-Control", edgeCacheControl);
      const edgeResponse = new Response(response.clone().body, { status: 200, headers: edgeHeaders });
      ctx.waitUntil(cache.put(cacheKey, edgeResponse));
    }
    return response;
  },
};
