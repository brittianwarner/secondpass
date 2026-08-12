// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): cors-wildcard
// A prose warning comment, with no quoted header name and no
// `origin:` configuration syntax anywhere — nothing here is
// machine-parseable as the vulnerable shape.

import type { Context } from "../fixtures/http.js";

export function setCorsHeaders(c: Context, allowedOrigin: string): void {
  // Access-Control-Allow-Origin should never be set to a wildcard in
  // production — always validate against an allowlist instead.
  c.headers.set("Access-Control-Allow-Origin", allowedOrigin);
}
