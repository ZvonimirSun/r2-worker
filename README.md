# R2 read-only Worker

Requests to `/path/to/file` read the R2 object with key `path/to/file`. Query strings are ignored for R2 lookup but are part of the cache key. Only GET, HEAD and OPTIONS are accepted; there is no upload, delete or directory listing endpoint. CORS currently allows all origins.

Successful files have `Cache-Control: public, max-age=3600` for browsers (1 hour). GET responses are also stored with the Cloudflare Cache API with a 2,592,000-second (30-day) TTL at the serving data center; entries may be evicted earlier. Cache hits do not read R2; HEAD can reuse a cached GET. Missing objects and errors are not cached. The R2 key ignores the query string, but the edge cache key includes it, so both versioned paths and `?t=timestamp` produce new cache entries. If the object at an existing URL changes, that URL can remain stale at an edge for up to 30 days; prefer unique versioned URLs or purge the cached URL. Cache API entries are per data center rather than tiered, and local development does not prove global cache behavior.

This uses the standard Cache API available on Workers Free; it does not enable paid Cache Reserve or a paid cache tier. Keep R2 objects in the **Standard** storage class to use its free tier. Worker requests and R2 storage/operations still have free-tier quotas, so this cannot guarantee zero charges after those quotas are exceeded. Use a stable timestamp per image version, not a new timestamp on every view, or each request will miss the edge cache. Cache API operations should be tested on the deployed custom domain, not in the dashboard preview.

## Online setup and deployment

1. Run `npm install` and `npm run test`.
2. For a **new** Worker, choose an unused `name` in `wrangler.jsonc`, run `npm run deploy:check`, then `npx wrangler deploy --keep-vars --strict` once. Bind an R2 bucket in the Cloudflare dashboard under **Settings > Bindings**. The binding variable name must be `R2` (the bucket name can be anything).
3. Configure the route or custom domain in the dashboard. `workers_dev: false` and the absence of `routes` in this project leave route management to the dashboard.
4. Test the deployed URL with a known object, for example `curl -i https://your-domain/path/to/file`.

This project intentionally does not declare `vars`, `r2_buckets`, or routes in Wrangler: the production bucket and routing are managed online, not guessed locally. `keep_vars: true` and `--keep-vars` preserve dashboard-set plaintext variables; Wrangler also preserves secrets. `--strict` rejects uploads with conflicting remote changes. **Do not run `wrangler deploy` against an existing production Worker with this config.** The dry run reports `No bindings found`, and Wrangler does not preserve an existing R2 binding merely because `keep_vars` is set. For subsequent code changes, use the dashboard's code editor and verify the R2 binding remains attached, or first adopt a complete, reviewed Wrangler configuration as the source of truth. Neither path silently overwrites the online bucket selection with a local placeholder.

Run `npm run dev` to serve with the separate `wrangler.local.jsonc` binding and local R2 simulation. For example, place a test object with `npx wrangler r2 object put local-r2-files/hello.txt --file ./test/fixtures/hello.txt --content-type text/plain --local -c wrangler.local.jsonc`, then request `http://localhost:8787/hello.txt`. Set the correct Content-Type when uploading production objects as well. Never deploy `wrangler.local.jsonc` to production.
