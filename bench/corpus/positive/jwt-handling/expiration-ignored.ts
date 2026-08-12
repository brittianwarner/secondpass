// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: jwt-handling
// Token expiry is explicitly disabled — a token stolen months ago
// remains valid forever.

import jwt from "../fixtures/jsonwebtoken.js";

export function verifyApiToken(token: string, key: string): unknown {
  return jwt.verify(token, key, { ignoreExpiration: true });
}
