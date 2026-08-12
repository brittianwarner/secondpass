// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: unsafe-redirect
// The Location header is set directly from the request body — the same
// open-redirect shape, expressed as a raw header instead of a helper.

import type { Context } from "../fixtures/http.js";

export async function ssoReturnHandler(c: Context): Promise<Response> {
  const body = (await c.request.json()) as { returnUrl: string };
  return new Response(null, {
    status: 302,
    headers: { "Location": req.body.returnUrl },
  });
}

declare const req: { body: { returnUrl: string } };
