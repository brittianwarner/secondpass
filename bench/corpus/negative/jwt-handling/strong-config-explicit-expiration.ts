// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): jwt-handling
// A strong asymmetric algorithm and expiration explicitly enforced —
// the same option-object shape as the vulnerable cases, with safe
// values instead.

import jwt from "../fixtures/jsonwebtoken.js";

export function verifyApiToken(token: string, publicKey: string): unknown {
  return jwt.verify(token, publicKey, { algorithms: ["RS256"], ignoreExpiration: false });
}
