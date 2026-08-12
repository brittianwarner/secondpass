// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: insecure-crypto
// Passwords hashed with unsalted MD5 — trivially reversible via
// rainbow tables the moment the hash leaks.

import { createHash } from "../fixtures/crypto.js";

export function hashPassword(password: string): string {
  return createHash("md5").update(password).digest("hex");
}
