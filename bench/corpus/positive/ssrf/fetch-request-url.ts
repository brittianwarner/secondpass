// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: ssrf
// The webhook relay fetches whatever URL the caller supplies, with no
// host allowlist. An attacker can point it at the metadata service or
// any internal-only host.

import type { Context } from "../fixtures/http.js";

export async function relayWebhookHandler(c: Context): Promise<Response> {
  const body = (await c.request.json()) as { url: string };
  const upstream = await fetch(req.body.url);
  return new Response(await upstream.text(), { status: upstream.status });
}

declare const req: { body: { url: string } };
