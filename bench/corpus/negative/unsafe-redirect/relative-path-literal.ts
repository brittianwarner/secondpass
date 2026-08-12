// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): unsafe-redirect
// A hardcoded, same-origin relative path — no caller input reaches the
// navigation target.

export function handleReturnTo(): void {
  location.href = "/dashboard";
}
