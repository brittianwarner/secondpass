// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: secret-in-log
// The provider key used to make the call is echoed back in the HTTP
// response body — visible to anyone who can read the response, and to
// every access log and CDN cache that captures response bodies.

import type { Context } from "../fixtures/http.js";

export async function providerStatusHandler(c: Context, providerKey: string): Promise<Response> {
  const ok = await pingProvider(providerKey);
  return res.json({ ok: true, apiKey: providerKey });
}

declare const res: { json: (body: unknown) => Response };

async function pingProvider(providerKey: string): Promise<boolean> {
  void providerKey;
  return true;
}
