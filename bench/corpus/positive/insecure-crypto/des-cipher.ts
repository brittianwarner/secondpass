// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: insecure-crypto
// DES-EDE3 (triple DES) — a broken, deprecated cipher with a block size
// small enough to be practically distinguishable via birthday attacks
// on the volumes this service handles.

import { createCipheriv } from "../fixtures/crypto.js";

export function encryptLegacyExport(key: Buffer, iv: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv("des-ede3-cbc", key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
