// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: jwt-handling
// The token is decoded and its claims are trusted directly — `decode`
// reads the payload without checking the signature at all, so any
// caller can hand-craft a token with `role: "admin"`.

import jwt from "../fixtures/jsonwebtoken.js";

export function getUserFromToken(token: string): { userId: string; role: string } {
  const claims = jwt.decode(token) as { userId: string; role: string };
  return claims;
}
