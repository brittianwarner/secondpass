// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): test-header-bypass
// A header whose name merely contains the word "test" as part of an
// unrelated compound word — a synthetic-monitoring latency probe
// header, not the "x-test-*" bypass shape.

import type { Context } from "../fixtures/http.js";

export function isLatencyProbe(c: Context): boolean {
  return Boolean(c.request.headers["x-latency-test"]);
}
