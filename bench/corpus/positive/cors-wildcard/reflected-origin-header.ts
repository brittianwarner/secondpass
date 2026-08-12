// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: cors-wildcard
// The caller's Origin header is reflected back unconditionally — this
// is wildcard-with-credentials in disguise, since it accepts literally
// any origin without checking it against anything.

import type { Context } from "../fixtures/http.js";

export function setCorsHeaders(c: Context): void {
  c.res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
}

declare const req: { headers: { origin: string } };
