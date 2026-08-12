// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): non-atomic-read-delete
// The comment shows the vulnerable shape as a warning. The real code
// uses an atomic delete-if-present operation instead of a separate
// check and delete.

import { cache } from "../fixtures/cache.js";

export async function processPayment(idempotencyKey: string): Promise<boolean> {
  // classic non-atomic bug: if (await cache.has(key)) { await
  // cache.delete(key) } — use an atomic op instead.
  const wasPresent = await cache.deleteIfExists(idempotencyKey);
  return wasPresent;
}
