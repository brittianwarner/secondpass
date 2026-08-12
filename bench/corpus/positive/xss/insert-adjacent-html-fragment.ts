// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: xss
// An untrusted fragment (assembled from search-result snippets) is
// inserted via insertAdjacentHTML with no escaping.

export function appendSearchResult(container: HTMLElement, untrustedFragment: string): void {
  container.insertAdjacentHTML("beforeend", untrustedFragment);
}
