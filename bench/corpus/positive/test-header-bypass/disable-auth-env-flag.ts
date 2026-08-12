// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: test-header-bypass
// A single environment variable, readable by any process on the host
// or settable via a misconfigured deploy, turns off the auth check for
// the entire service.

import type { Context } from "../fixtures/http.js";

export async function authMiddleware(c: Context): Promise<boolean> {
  if (process.env.DISABLE_AUTH_CHECK === "true") {
    return true;
  }
  return hasValidSession(c);
}

declare function hasValidSession(c: Context): boolean;
