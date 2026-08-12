// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): jwt-handling
// `decode` does appear here, but only after `verify` already ran and
// would have thrown on an invalid signature — this just re-reads the
// claims from a token already known to be authentic.

import jwt from "../fixtures/jsonwebtoken.js";

export function getUserFromToken(token: string, key: string): { userId: string; role: string } {
  jwt.verify(token, key, { algorithms: ["RS256"] }); // throws on an invalid signature
  const claims = jwt.decode(token) as { userId: string; role: string };
  return claims;
}
