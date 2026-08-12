// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): non-atomic-read-delete
// An inverted, atomic set-if-absent inside a transaction — this is the
// actual fix for the idempotency race, not the bug.

import { db } from "../fixtures/db.js";

export async function processPaymentOnce(idempotencyKey: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const exists = await tx.has(idempotencyKey);
    if (!exists) {
      await tx.set(idempotencyKey, true);
      return true;
    }
    return false;
  });
}
