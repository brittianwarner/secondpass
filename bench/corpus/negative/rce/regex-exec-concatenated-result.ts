// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE: rce
// `RegExp.prototype.exec` whose result is concatenated into a string. The
// member-access lookbehind is what keeps the concatenation pattern off this:
// `\bexec` alone matches the tail of `SEMVER.exec(...)`, which is matching,
// not executing.

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function describeVersion(input: string): string {
  const parts = SEMVER.exec(input);
  if (parts === null) return "unparsed";
  return "major " + parts[1] + ", minor " + parts[2];
}
