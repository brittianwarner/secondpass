// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: non-atomic-read-delete
// The rate limiter's existence check and its consume step are two
// separate awaited calls — a burst of concurrent requests can all pass
// the `exists` check before any of them consumes the token.

import { rateLimiter } from "../fixtures/rate-limiter.js";

export async function guardedEndpoint(key: string): Promise<boolean> {
  if (await rateLimiter.exists(key)) {
    await rateLimiter.consume(key);
    return true;
  }
  return false;
}
