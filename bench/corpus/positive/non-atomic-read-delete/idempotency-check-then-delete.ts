// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: non-atomic-read-delete
// Two concurrent requests with the same idempotency key can both pass
// the `has` check before either deletes the key — both then treat the
// request as fresh and the operation runs twice.

import { cache } from "../fixtures/cache.js";

export async function processPayment(idempotencyKey: string): Promise<void> {
  if (await cache.has(idempotencyKey)) {
    await cache.delete(idempotencyKey);
    await chargeCustomer(idempotencyKey);
  }
}

async function chargeCustomer(idempotencyKey: string): Promise<void> {
  void idempotencyKey;
}
