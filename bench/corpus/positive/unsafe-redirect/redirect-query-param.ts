// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: unsafe-redirect
// The post-login redirect target comes straight from the query string.
// An attacker sends `?next=https://evil.example/phish` in a link and
// the app redirects an authenticated session there.

import type { Context } from "../fixtures/http.js";

export async function postLoginHandler(c: Context): Promise<Response> {
  await completeLogin(c);
  return redirect(302, req.query.next);
}

declare const req: { query: { next: string } };
declare function redirect(status: number, target: string): Response;

async function completeLogin(c: Context): Promise<void> {
  void c;
}
