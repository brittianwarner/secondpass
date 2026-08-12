// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): xss
// `textContent`, not `innerHTML` — the browser never parses the string
// as markup, so there is no injection surface here regardless of what
// the user typed.

export function appendSearchResult(container: HTMLElement, snippet: string): void {
  const el = document.createElement("span");
  el.textContent = snippet;
  container.appendChild(el);
}
