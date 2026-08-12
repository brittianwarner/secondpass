// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): unsafe-redirect
// The redirect target is read from the query string, but it is checked
// against a fixed allowlist before it is ever used — the fix applied to
// redirect-query-param.ts's exact vulnerability.

declare function redirect(status: number, target: string): Response;

const ALLOWED_REDIRECTS = new Set(["/home", "/settings", "/billing"]);

export function handleCheckoutReturn(url: URL): Response {
  const next = url.searchParams.get("next");
  if (!next || !ALLOWED_REDIRECTS.has(next)) {
    return redirect(303, "/home");
  }
  return redirect(303, next);
}
