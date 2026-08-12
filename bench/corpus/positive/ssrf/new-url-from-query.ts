// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: ssrf
// The OAuth callback URL is built straight from the query string and
// then dereferenced, with no host check.

import type { Context } from "../fixtures/http.js";

export async function oauthCallbackHandler(c: Context): Promise<Response> {
  const callback = new URL(req.query.callback);
  const upstream = await fetch(callback);
  return new Response(await upstream.text());
}

declare const req: { query: { callback: string } };
