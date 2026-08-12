// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): ssrf
// The comment shows the vulnerable shape as a warning. The real call
// below resolves against a host allowlist first.

import type { Context } from "../fixtures/http.js";
import { resolveAllowedHost } from "../fixtures/net.js";

export async function relayWebhookHandler(c: Context): Promise<Response> {
  const body = (await c.request.json()) as { url: string };
  // e.g. axios.get(req.body.url) — never fetch a caller-supplied URL raw.
  const target = await resolveAllowedHost(body.url);
  const upstream = await fetch(target);
  return new Response(await upstream.text(), { status: upstream.status });
}
