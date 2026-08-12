// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: rce
// A literal command prefix concatenated with a request value. The quoted
// prefix is what hid this shape: the template-literal pattern needs a
// backtick, and the non-literal pattern skips anything opening with a quote.

import { exec } from "../fixtures/child-process.js";

export function readBranchLog(req: { body: { branch: string } }): void {
  exec("git log --oneline " + req.body.branch, () => {});
}
