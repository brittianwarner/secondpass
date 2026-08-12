// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): rce
// The branch name is interpolated too, but only after it passes a
// fixed allowlist check — the exact fix for exec-sync-interpolated-
// branch.ts's vulnerability.

import { execSync } from "../fixtures/child-process.js";

const ALLOWED_BRANCHES = new Set(["main", "staging"]);

export function checkoutBranch(branch: string): void {
  if (!ALLOWED_BRANCHES.has(branch)) {
    throw new Error("invalid branch");
  }
  execSync(`git checkout ${branch}`);
}
