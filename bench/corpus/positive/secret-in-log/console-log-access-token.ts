// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: secret-in-log
// Left over from a debugging session — the raw access token is printed
// to stdout, which on this host ships straight to the log aggregator.

export async function refreshAccessToken(accessToken: string): Promise<void> {
  console.log("token", accessToken);
  await persistToken(accessToken);
}

async function persistToken(accessToken: string): Promise<void> {
  void accessToken;
}
