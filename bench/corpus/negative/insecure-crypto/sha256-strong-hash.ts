// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): insecure-crypto
// SHA-256, not MD5/SHA-1 — a modern, unbroken digest algorithm.

import { createHash } from "../fixtures/crypto.js";

export function hashPayload(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}
