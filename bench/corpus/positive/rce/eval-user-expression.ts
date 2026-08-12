// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: rce
// A "formula" field from a spreadsheet import is evaluated with `eval`
// — any JavaScript in that cell runs with full process privileges.

export function computeCell(userExpression: string): unknown {
  return eval(userExpression);
}
