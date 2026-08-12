// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): jwt-handling
// The comment shows the vulnerable call as a warning. The real code
// verifies the signature before trusting anything in the token.

import jwt from "../fixtures/jsonwebtoken.js";

export function getUserFromToken(token: string, key: string): { userId: string; role: string } {
  // jwt.decode(token) is unsafe without verify() — always call
  // jwt.verify instead so the signature is actually checked.
  const claims = jwt.verify(token, key, { algorithms: ["RS256"] }) as { userId: string; role: string };
  return claims;
}
