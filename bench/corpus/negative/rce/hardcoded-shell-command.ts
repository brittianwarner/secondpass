// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): rce
// A fully hardcoded, literal command with no interpolation and no
// caller-supplied input anywhere in the string.

import { execSync } from "../fixtures/child-process.js";

export function checkWorkingTreeClean(): string {
  return execSync("git status --porcelain").toString();
}
