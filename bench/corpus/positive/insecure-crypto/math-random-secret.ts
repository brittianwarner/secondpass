// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: insecure-crypto
// A webhook signing secret generated from `Math.random()` — not a CSPRNG,
// and its output is predictable enough to brute-force in practice.

export function generateWebhookSecret(): string {
  const secretValue = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return secretValue;
}
