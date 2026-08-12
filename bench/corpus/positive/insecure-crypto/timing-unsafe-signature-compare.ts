// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: insecure-crypto
// The webhook signature is compared with `===`, which short-circuits on
// the first mismatched byte — an attacker who can measure response
// timing can recover the expected signature one byte at a time.

export function verifyWebhookSignature(signature: string, expectedSignature: string): boolean {
  if (signature === expectedSignature) {
    return true;
  }
  return false;
}
