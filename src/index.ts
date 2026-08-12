/**
 * secondpass — public barrel.
 *
 * A two-stage security scanner:
 *
 *   scan        free, deterministic. Regex matchers walk the project and
 *               emit `Candidate`s — locations worth a model's attention.
 *               Never touches the network or a model.
 *   adjudicate  costed, model-driven. Turns `Candidate`s into `Finding`s:
 *               a verdict, a severity, and the reasoning that has to
 *               survive review.
 *
 * A candidate is NOT a finding. Most candidates are noise — that's the
 * design. See `./types.js` for the full contract, and this package's
 * `README.md` for the full story (install, quickstart, writing a matcher
 * pack, provenance) and `AGENTS.md` for notes specific to working on this
 * source.
 *
 * This package is pure logic: no database, no queue, no daemon, and no
 * network call from the scan stage. The only runtime it needs is agentOS,
 * and only for the adjudication stage — a run is a function call that
 * returns a result and a JSON file on disk. Anything more durable than that
 * (retrying a killed run, fanning adjudication across a fleet, keeping a
 * multi-tenant ledger) is the caller's to build, on whatever they already
 * run.
 */

// Contracts — the seam scan, adjudicate, and orchestration all share.
export type {
  Candidate,
  Finding,
  Matcher,
  MatcherPattern,
  NoiseTier,
  ProjectConfig,
  ScannedFile,
  ScanResult,
  Severity,
  Verdict,
} from "./types.js";
export { CONFIDENCE_FLOOR, DEFAULT_IGNORE } from "./types.js";

// Matcher registry — the default pattern set the scan stage runs, plus
// `composeMatchers` for merging in your own. `ALL_MATCHERS` stays generic
// (builtin + multi-tenancy families); anything that depends on one team's
// conventions belongs in a pack you write, not here — see the README's
// "Writing your own matcher pack":
//
//   import { ALL_MATCHERS, composeMatchers } from "secondpass";
//   import { HOUSE_RULES } from "./my-matchers.js";
//   const matchers = composeMatchers({ base: ALL_MATCHERS, packs: [HOUSE_RULES] });
export { ALL_MATCHERS, composeMatchers, getMatcher, matchersForTier } from "./matchers/index.js";

// Scan stage — free, deterministic, regex-only.
export { scanContent, scanProject } from "./scanner.js";

// Adjudication stage — prompt construction and response parsing. The
// costed model call itself is the caller's transport (e.g. the agentOS
// sandbox runner below); this module stays transport-agnostic.
export {
  ADJUDICATION_SYSTEM_PROMPT,
  batchCandidates,
  buildAdjudicationPrompt,
  parseAdjudicationResponse,
} from "./adjudication.js";

// NOTE: the agentOS sandbox transport (`adjudicateInSandbox`,
// `adjudicateBatch`) is deliberately NOT re-exported here. It resolves the
// heavy agentOS packages that most consumers of this barrel — the scan
// stage, matcher authoring, prompt/parsing tests — never need. Import it
// directly: `secondpass/sandbox`.
