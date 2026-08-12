// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: rce
// The branch name comes from the request and is interpolated straight
// into a shell command — a branch named `main; rm -rf /` runs as two
// commands.

import { execSync } from "../fixtures/child-process.js";

export function checkoutBranch(branch: string): void {
  execSync(`git checkout ${branch}`);
}
