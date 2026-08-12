// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: jwt-handling
// The payload is pulled out by hand-splitting the token on dots and
// base64-decoding the middle segment — no signature check happens
// anywhere in this function.

export function readTokenClaims(token: string): Record<string, unknown> {
  const payloadJson = atob(token.split(".")[1]);
  return JSON.parse(payloadJson);
}
