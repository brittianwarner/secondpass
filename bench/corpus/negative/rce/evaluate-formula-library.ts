// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): rce
// A math-expression evaluator's `evaluate()` function — a sandboxed
// arithmetic parser, not the JavaScript global that runs arbitrary
// code. The names look alike; the capability is not.

import { evaluate } from "../fixtures/expression-parser.js";

export function computeCell(formula: string, scope: Record<string, number>): number {
  return evaluate(formula, scope);
}
