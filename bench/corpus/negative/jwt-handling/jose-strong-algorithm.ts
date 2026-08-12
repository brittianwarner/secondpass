// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): jwt-handling
// A different verification API (`jose`'s `jwtVerify`), a strong
// asymmetric algorithm, and a real signature check — the correct shape.

import { jwtVerify } from "../fixtures/jose.js";
import type { KeyLike } from "../fixtures/jose.js";

export async function getUserFromToken(
  token: string,
  publicKey: KeyLike,
): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(token, publicKey, { algorithms: ["EdDSA"] });
  return payload;
}
