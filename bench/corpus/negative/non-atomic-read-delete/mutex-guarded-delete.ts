// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): non-atomic-read-delete
// The check-then-delete is wrapped in a mutex that serializes every
// caller for this key — no two callers ever run the block concurrently,
// so the race the bare pattern has does not exist here.

import { cache } from "../fixtures/cache.js";
import { mutex } from "../fixtures/mutex.js";

export async function processPayment(idempotencyKey: string): Promise<void> {
  await mutex.runExclusive(idempotencyKey, async () => {
    if (await cache.has(idempotencyKey)) {
      await cache.delete(idempotencyKey);
    }
  });
}
