// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): insecure-crypto
// The same comparison shape, but neither identifier names a secret —
// this compares two plain user ids, where timing leakage discloses
// nothing an attacker doesn't already know.

export function isSameUser(userId: string, expectedUserId: string): boolean {
  return userId === expectedUserId;
}
