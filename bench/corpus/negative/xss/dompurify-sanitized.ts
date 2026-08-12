// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): xss
// The raw HTML is sanitized through DOMPurify before it ever reaches
// innerHTML — this is the correct fix, applied.

import DOMPurify from "../fixtures/dompurify.js";

export function renderComment(container: HTMLElement, userComment: string): void {
  container.innerHTML = DOMPurify.sanitize(userComment);
}
