// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: xss
// Raw HTML pulled from an upstream CMS response is rendered without a
// sanitizer pass. A compromised or misconfigured CMS becomes stored XSS
// for every visitor.

import * as React from "../fixtures/react.js";

export function ArticleBody({ rawHtml }: { rawHtml: string }): unknown {
  return React.createElement("div", { dangerouslySetInnerHTML: { __html: rawHtml } });
}
