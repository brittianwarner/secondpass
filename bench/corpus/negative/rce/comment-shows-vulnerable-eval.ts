// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): rce
// The comment shows the vulnerable call as a warning. The real code
// parses the value as JSON, never as executable script.

export function computeCell(userExpression: string): unknown {
  // never call eval(userInput) directly — this parses the value as
  // data instead, so it can never run as code.
  return JSON.parse(userExpression);
}
