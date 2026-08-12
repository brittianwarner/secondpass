// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): cors-wildcard
// The Origin header is checked against a fixed allowlist first — only
// an already-approved origin ever gets echoed back, and the value
// handed to setHeader is the validated local variable, not the raw
// request header.

import type { Context } from "../fixtures/http.js";

const ALLOWED_ORIGINS = new Set(["https://app.example.com", "https://dev.example.com"]);

export function setCorsHeaders(c: Context): void {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    c.res.setHeader("Access-Control-Allow-Origin", origin);
  }
}

declare const req: { headers: { origin: string } };
