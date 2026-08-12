// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: rce
// The whole command string is caller-supplied and passed to `exec`
// as-is — this is direct shell command injection, not just argument
// injection.

import { exec } from "../fixtures/child-process.js";

export function runDiagnostic(shellCommand: string, callback: (err: unknown, out: string) => void): void {
  exec(shellCommand, (err, stdout) => callback(err, stdout));
}
