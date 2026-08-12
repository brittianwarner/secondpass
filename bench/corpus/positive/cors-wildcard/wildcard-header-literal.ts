// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: cors-wildcard
// A wildcard CORS origin on a route that also sets credentials — the
// combination browsers otherwise refuse, opening any origin's page to
// read cookie-authenticated responses via a misconfigured proxy.

import type { Context } from "../fixtures/http.js";

export function setCorsHeaders(c: Context): void {
  c.headers.set("Access-Control-Allow-Origin", "*");
  c.headers.set("Access-Control-Allow-Credentials", "true");
}
