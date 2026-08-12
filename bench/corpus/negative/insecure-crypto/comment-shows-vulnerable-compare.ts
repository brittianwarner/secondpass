// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): insecure-crypto
// The comment shows the vulnerable comparison as a warning. The real
// check below uses a constant-time comparison.

import { timingSafeEqual } from "../fixtures/crypto.js";

export function verifyWebhookSignature(signature: Buffer, expectedSignature: Buffer): boolean {
  // never compare signature === expectedSignature directly — that leaks
  // timing information one byte at a time.
  return timingSafeEqual(signature, expectedSignature);
}
