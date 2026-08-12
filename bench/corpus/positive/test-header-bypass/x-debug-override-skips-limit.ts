// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: test-header-bypass
// A debug header that disables rate limiting — reachable by anyone who
// knows (or guesses) the header name, in every environment.

import type { Context } from "../fixtures/http.js";

export async function rateLimitMiddleware(c: Context): Promise<void> {
  if (c.request.headers["x-debug-override"] === "true") {
    skipRateLimit();
    return;
  }
  await enforceRateLimit(c);
}

declare function skipRateLimit(): void;
declare function enforceRateLimit(c: Context): Promise<void>;
