// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): xss
// The comment shows the vulnerable shape as a warning. The real
// assignment below goes through the DOM text API, which never parses
// its argument as markup.

export function renderComment(container: HTMLElement, userComment: string): void {
  // avoid el.innerHTML = data — sanitize first via DOMPurify, or better,
  // avoid HTML rendering entirely for plain user comments.
  container.textContent = userComment;
}
