// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): test-header-bypass
// The comment quotes the removed header exactly as it once appeared in
// code, as a warning against reintroducing it. The real middleware
// below only ever checks a real session.

import type { Context } from "../fixtures/http.js";

export async function authMiddleware(c: Context): Promise<unknown> {
  // req.headers["x-test-user"] was removed in v2 — see LAY-482. Never
  // reintroduce a header-based auth override.
  return requireRealSession(c);
}

declare function requireRealSession(c: Context): unknown;
