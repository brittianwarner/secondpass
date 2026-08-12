// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: rce
// A caller-controlled directory name is interpolated into a Bun shell
// template used for cleanup — the same injection surface as
// `execSync`, via `Bun.$`.

import { $ } from "../fixtures/bun-shell.js";

export async function cleanupWorkspace(targetDir: string): Promise<void> {
  await $`rm -rf ${targetDir}`;
}
