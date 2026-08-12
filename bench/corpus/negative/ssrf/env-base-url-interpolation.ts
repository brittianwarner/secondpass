// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): ssrf
// The URL is interpolated, but the interpolated segment is a
// deploy-time constant base URL, never caller input.

const API_BASE_URL = "https://internal-metrics.example.internal";

export async function healthCheckHandler(): Promise<boolean> {
  const response = await fetch(`${API_BASE_URL}/health-check`);
  return response.ok;
}
