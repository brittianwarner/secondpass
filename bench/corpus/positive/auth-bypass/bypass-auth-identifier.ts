// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: auth-bypass
// A "temporary" internal-call fast path that skips the normal guard
// entirely. Nothing checks that the caller actually is internal — the
// function name is the only signal, and any route can import it.

import type { Context } from "../fixtures/http.js";

export async function webhookIngestHandler(c: Context): Promise<Response> {
  bypassAuthForWebhook(c);
  const payload = await c.request.json();
  return c.json({ received: true, keys: Object.keys(payload as object) });
}

function bypassAuthForWebhook(c: Context): void {
  // Intended for the internal webhook relay only — never verified.
  void c;
}
