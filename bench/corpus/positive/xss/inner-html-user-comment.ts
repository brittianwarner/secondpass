// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: xss
// A user-authored comment is written straight into innerHTML with no
// sanitization — any HTML or <script> the commenter typed executes in
// every viewer's session.

export function renderComment(container: HTMLElement, userComment: string): void {
  container.innerHTML = userComment;
}
