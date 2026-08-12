// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: unsafe-redirect
// The "return to" target is read from the query string and assigned
// directly to `location.href` — open redirect straight from the URL.

export function handleReturnTo(params: URLSearchParams): void {
  const redirectTarget = params.get("returnTo") ?? "/";
  location.href = redirectTarget;
}
