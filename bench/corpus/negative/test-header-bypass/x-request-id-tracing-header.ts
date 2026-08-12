// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): test-header-bypass
// A distributed-tracing correlation header — read for observability
// only, never consulted for any authorization or control decision.

import type { Context } from "../fixtures/http.js";

export function getTraceId(c: Context): string {
  return c.request.headers["x-request-id"] ?? crypto.randomUUID();
}
