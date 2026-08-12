// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: jwt-handling
// The verifier accepts the "none" algorithm — the classic alg=none
// forgery lets an attacker submit an unsigned token and have it
// accepted as valid.

import jwt from "../fixtures/jsonwebtoken.js";

export function verifySessionToken(token: string, key: string): unknown {
  return jwt.verify(token, key, { algorithms: ["none"] });
}
