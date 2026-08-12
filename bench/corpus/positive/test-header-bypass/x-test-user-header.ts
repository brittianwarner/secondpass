// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: test-header-bypass
// A "for tests only" header that is honored unconditionally in
// production code — any external caller can set this header themselves
// and impersonate an arbitrary user.

import type { Context } from "../fixtures/http.js";

export async function authMiddleware(c: Context): Promise<unknown> {
  if (c.request.headers["x-test-user"]) {
    return { userId: c.request.headers["x-test-user"], impersonated: true };
  }
  return requireRealSession(c);
}

declare function requireRealSession(c: Context): unknown;
