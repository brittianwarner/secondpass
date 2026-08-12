// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): test-header-bypass
// A plain deployment-region environment variable — no
// disable/skip/bypass/allow-insecure/unsafe naming anywhere near it.

export function getDeploymentRegion(): string {
  return process.env.AWS_REGION ?? "us-east-1";
}
