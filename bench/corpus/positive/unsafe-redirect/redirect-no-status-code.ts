// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: unsafe-redirect
// Same open-redirect shape, called without an explicit status code —
// `url.searchParams` is dereferenced straight into the redirect target.

declare function redirect(target: string): Response;

export function handleCheckoutReturn(url: URL): Response {
  return redirect(url.searchParams.get("next") ?? "/");
}
