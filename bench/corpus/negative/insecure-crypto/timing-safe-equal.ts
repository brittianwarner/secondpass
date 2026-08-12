// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): insecure-crypto
// A genuine constant-time comparison via Node's `crypto.timingSafeEqual`
// — the secret-named values are never compared with `==`/`===` at all.

import { timingSafeEqual } from "../fixtures/crypto.js";

export function verifyWebhookSignature(signature: Buffer, expectedSignature: Buffer): boolean {
  if (signature.length !== expectedSignature.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}
