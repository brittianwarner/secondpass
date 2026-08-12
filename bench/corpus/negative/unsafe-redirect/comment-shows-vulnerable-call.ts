// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): unsafe-redirect
// The comment shows the vulnerable call as a warning. The real redirect
// below only ever targets a fixed, hardcoded path.

import type { Context } from "../fixtures/http.js";

export async function postLoginHandler(c: Context): Promise<Response> {
  // never do redirect(302, req.query.next) without validating against an
  // allowlist of known-safe paths first.
  await completeLogin(c);
  return redirect(302, "/dashboard");
}

declare function redirect(status: number, target: string): Response;

async function completeLogin(c: Context): Promise<void> {
  void c;
}
