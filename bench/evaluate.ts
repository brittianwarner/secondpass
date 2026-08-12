/**
 * secondpass scan-stage evaluation harness.
 *
 * Runs the full matcher registry (the real scan stage, unmodified) against
 * the labeled corpus at `bench/corpus/manifest.json` and reports precision /
 * recall / F1 / F2 per matcher family and in aggregate, plus the raw
 * confusion matrix behind those rates.
 *
 * Why F2, not F1: see bench/README.md for the full argument. Short version
 * — a false negative in the scan stage is invisible forever (adjudication
 * only ever sees what scan emitted), a false positive is cheap (adjudication
 * filters it). F2 weights recall 2x for exactly that reason, and it is the
 * number this harness treats as the headline metric. Do not "fix" a family
 * by deleting patterns to chase precision; read the README before touching
 * anything based on this harness's output.
 *
 * Usage:
 *   bun bench/evaluate.ts                      human-readable table
 *   bun bench/evaluate.ts --json                machine-readable report
 *   bun bench/evaluate.ts --save run.json        write this run as a baseline
 *   bun bench/evaluate.ts --baseline run.json     diff against a saved baseline
 *
 * This file imports the real scan stage (`scanContent`) and the real matcher
 * registry (`../src/matchers/index.js`) and nothing else from `src/` is
 * touched or mutated — the harness is read-only with respect to both the
 * scanner and the corpus.
 *
 * Matcher set: `ALL_MATCHERS` — every family this package ships, which is
 * also what `scanProject` runs when a caller passes no `matchers`. A pack you
 * write yourself is out of scope here by construction: this corpus can only
 * score patterns it was labeled against.
 */

import { scanContent } from "../src/scanner.js";
import { ALL_MATCHERS } from "../src/matchers/index.js";
import type { Candidate } from "../src/types.js";

/** Every matcher this package ships — the same set a default scan runs. */
const EVAL_MATCHERS = ALL_MATCHERS;

/**
 * A candidate counts as hitting a labeled line if it lands on that exact
 * line or within this many lines of it. Multi-line patterns legitimately
 * report a range (e.g. a multi-line SQL template), so an exact-line-only
 * comparison would under-count real hits.
 */
const LINE_TOLERANCE = 2;

/** Below this recall, a family is flagged `NEEDS WORK` regardless of precision. */
const RECALL_THRESHOLD = 0.8;

/** Below this precision, a family is flagged `NEEDS WORK` regardless of recall. */
const PRECISION_THRESHOLD = 0.3;

/** Float-noise guard for baseline delta comparisons — not a real threshold. */
const REGRESSION_EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Manifest contract (sibling corpus is built independently — see the doc
// comment on `parseManifest` for how this harness stays safe if the corpus
// hasn't landed yet, or drifts from this shape).
// ---------------------------------------------------------------------------

interface ManifestCase {
  /** Path to the fixture file, relative to `bench/corpus/`. */
  file: string;
  expect: "hit" | "miss";
  /** The matcher family (`Matcher.slug`) this case is testing. */
  slug: string;
  /** 1-indexed. Required for `hit` cases; optional for `miss` cases. */
  line?: number;
  note?: string;
}

interface Manifest {
  cases: ManifestCase[];
}

function parseManifestCase(params: { entry: unknown; index: number; manifestPath: string }): ManifestCase {
  const { entry, index, manifestPath } = params;
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`${manifestPath}: cases[${index}] is not an object`);
  }
  const record = entry as Record<string, unknown>;
  const { file, expect, slug, line, note } = record;

  if (typeof file !== "string" || file.length === 0) {
    throw new Error(`${manifestPath}: cases[${index}].file must be a non-empty string`);
  }
  if (expect !== "hit" && expect !== "miss") {
    throw new Error(`${manifestPath}: cases[${index}].expect must be "hit" or "miss"`);
  }
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error(`${manifestPath}: cases[${index}].slug must be a non-empty string`);
  }
  if (line !== undefined && typeof line !== "number") {
    throw new Error(`${manifestPath}: cases[${index}].line must be a number if present`);
  }
  if (note !== undefined && typeof note !== "string") {
    throw new Error(`${manifestPath}: cases[${index}].note must be a string if present`);
  }

  return { file, expect, slug, line, note };
}

function parseManifest(params: { raw: unknown; manifestPath: string }): Manifest {
  const { raw, manifestPath } = params;
  if (typeof raw !== "object" || raw === null || !("cases" in raw)) {
    throw new Error(`${manifestPath}: expected a JSON object with a "cases" array`);
  }
  const casesRaw = (raw as { cases: unknown }).cases;
  if (!Array.isArray(casesRaw)) {
    throw new Error(`${manifestPath}: "cases" must be an array`);
  }
  const cases = casesRaw.map((entry, index) => parseManifestCase({ entry, index, manifestPath }));
  return { cases };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface FamilyCounts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

type FamilyStatus = "OK" | "NEEDS WORK" | "NO DATA";

interface FamilyMetrics extends FamilyCounts {
  slug: string;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  f2: number | null;
  status: FamilyStatus;
}

interface EvaluationReport {
  generatedAt: string;
  manifestPath: string;
  totalCases: number;
  evaluatedCases: number;
  skippedCases: number;
  skippedReasons: string[];
  families: FamilyMetrics[];
  aggregate: FamilyMetrics;
}

/** A candidate matches a labeled line if any of its lines is within tolerance. */
function lineMatches(candidateLines: readonly number[], targetLine: number): boolean {
  return candidateLines.some((line) => Math.abs(line - targetLine) <= LINE_TOLERANCE);
}

/** Standard F-beta: (1+beta^2)*P*R / (beta^2*P + R). `null` propagates from missing P or R. */
function fBeta(params: { precision: number | null; recall: number | null; beta: number }): number | null {
  const { precision, recall, beta } = params;
  if (precision === null || recall === null) {
    return null;
  }
  const beta2 = beta * beta;
  const denom = beta2 * precision + recall;
  return denom === 0 ? 0 : ((1 + beta2) * precision * recall) / denom;
}

function derivePrecisionRecall(counts: FamilyCounts): { precision: number | null; recall: number | null } {
  const precision = counts.tp + counts.fp > 0 ? counts.tp / (counts.tp + counts.fp) : null;
  const recall = counts.tp + counts.fn > 0 ? counts.tp / (counts.tp + counts.fn) : null;
  return { precision, recall };
}

function familyStatus(params: { precision: number | null; recall: number | null }): FamilyStatus {
  const { precision, recall } = params;
  if (precision === null && recall === null) {
    return "NO DATA";
  }
  const failsRecall = recall !== null && recall < RECALL_THRESHOLD;
  const failsPrecision = precision !== null && precision < PRECISION_THRESHOLD;
  return failsRecall || failsPrecision ? "NEEDS WORK" : "OK";
}

function buildFamilyMetrics(params: { slug: string; counts: FamilyCounts }): FamilyMetrics {
  const { slug, counts } = params;
  const { precision, recall } = derivePrecisionRecall(counts);
  return {
    slug,
    ...counts,
    precision,
    recall,
    f1: fBeta({ precision, recall, beta: 1 }),
    f2: fBeta({ precision, recall, beta: 2 }),
    status: familyStatus({ precision, recall }),
  };
}

function getOrCreateCounts(params: {
  countsBySlug: Map<string, FamilyCounts>;
  slug: string;
  warnings: string[];
}): FamilyCounts {
  const { countsBySlug, slug, warnings } = params;
  let counts = countsBySlug.get(slug);
  if (!counts) {
    counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
    countsBySlug.set(slug, counts);
    warnings.push(
      `manifest references slug "${slug}" with no matching entry in the matcher registry — corpus/matcher drift`,
    );
  }
  return counts;
}

/**
 * Scores every manifest case against the real scan stage and rolls the
 * results up into per-family + aggregate confusion matrices and rates.
 *
 * Every matcher in `EVAL_MATCHERS` is seeded into the family table up front,
 * even ones with zero corpus coverage — a family the corpus hasn't reached
 * yet must show up as `NO DATA`, not silently vanish from the report.
 */
async function computeReport(params: { manifest: Manifest; corpusDir: string; manifestPath: string }): Promise<EvaluationReport> {
  const { manifest, corpusDir, manifestPath } = params;

  const countsBySlug = new Map<string, FamilyCounts>();
  for (const matcher of EVAL_MATCHERS) {
    countsBySlug.set(matcher.slug, { tp: 0, fp: 0, fn: 0, tn: 0 });
  }

  const warnings: string[] = [];
  const scanCache = new Map<string, Candidate[]>();
  let evaluatedCases = 0;

  for (const testCase of manifest.cases) {
    let candidates = scanCache.get(testCase.file);
    if (!candidates) {
      const fullPath = `${corpusDir}/${testCase.file}`;
      const bunFile = Bun.file(fullPath);
      if (!(await bunFile.exists())) {
        warnings.push(`${testCase.file}: file not found at ${fullPath} — case skipped`);
        continue;
      }
      const content = await bunFile.text();
      candidates = scanContent({ filePath: testCase.file, content, matchers: EVAL_MATCHERS });
      scanCache.set(testCase.file, candidates);
    }

    const counts = getOrCreateCounts({ countsBySlug, slug: testCase.slug, warnings });
    const familyCandidates = candidates.filter((candidate) => candidate.vulnSlug === testCase.slug);

    if (testCase.expect === "hit") {
      if (testCase.line === undefined) {
        warnings.push(`${testCase.file} (${testCase.slug}): "hit" case has no "line" — case skipped`);
        continue;
      }
      const fired = familyCandidates.some((candidate) => lineMatches(candidate.lineNumbers, testCase.line as number));
      if (fired) {
        counts.tp += 1;
      } else {
        counts.fn += 1;
      }
    } else {
      // "miss" case: if a line is given it marks the specific near-miss
      // site under test, so we check that site; otherwise any hit by this
      // family anywhere in the file counts as the false positive.
      const fired =
        testCase.line !== undefined
          ? familyCandidates.some((candidate) => lineMatches(candidate.lineNumbers, testCase.line as number))
          : familyCandidates.length > 0;
      if (fired) {
        counts.fp += 1;
      } else {
        counts.tn += 1;
      }
    }

    evaluatedCases += 1;
  }

  const families = Array.from(countsBySlug.entries())
    .map(([slug, counts]) => buildFamilyMetrics({ slug, counts }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const totals = families.reduce<FamilyCounts>(
    (acc, family) => ({
      tp: acc.tp + family.tp,
      fp: acc.fp + family.fp,
      fn: acc.fn + family.fn,
      tn: acc.tn + family.tn,
    }),
    { tp: 0, fp: 0, fn: 0, tn: 0 },
  );

  return {
    generatedAt: new Date().toISOString(),
    manifestPath,
    totalCases: manifest.cases.length,
    evaluatedCases,
    skippedCases: manifest.cases.length - evaluatedCases,
    skippedReasons: warnings,
    families,
    aggregate: buildFamilyMetrics({ slug: "AGGREGATE", counts: totals }),
  };
}

// ---------------------------------------------------------------------------
// Baseline comparison
// ---------------------------------------------------------------------------

type FamilyVerdict = "IMPROVED" | "REGRESSED" | "NO CHANGE" | "NEW" | "REMOVED";
type OverallVerdict = "IMPROVED" | "REGRESSED" | "NO CHANGE";

interface FamilyComparison {
  slug: string;
  current: FamilyMetrics | null;
  baseline: FamilyMetrics | null;
  deltaPrecision: number | null;
  deltaRecall: number | null;
  deltaF1: number | null;
  deltaF2: number | null;
  verdict: FamilyVerdict;
}

interface ComparisonResult {
  baselinePath: string;
  overallVerdict: OverallVerdict;
  aggregate: FamilyComparison;
  families: FamilyComparison[];
}

function numericDelta(current: number | null, baseline: number | null): number | null {
  return current === null || baseline === null ? null : current - baseline;
}

/**
 * Verdict is driven by F2 — the same headline metric the report uses —
 * because that's the number this harness exists to protect. A family that
 * loses its baseline score entirely (current is `null` where baseline had
 * a value) is treated as REGRESSED, not "no data": losing corpus coverage
 * for a family that used to be measured is itself a signal worth catching.
 */
function compareFamily(params: { slug: string; current: FamilyMetrics | null; baseline: FamilyMetrics | null }): FamilyComparison {
  const { slug, current, baseline } = params;

  if (baseline === null && current !== null) {
    return { slug, current, baseline, deltaPrecision: null, deltaRecall: null, deltaF1: null, deltaF2: null, verdict: "NEW" };
  }
  if (baseline !== null && current === null) {
    return { slug, current, baseline, deltaPrecision: null, deltaRecall: null, deltaF1: null, deltaF2: null, verdict: "REMOVED" };
  }
  if (baseline === null || current === null) {
    return { slug, current, baseline, deltaPrecision: null, deltaRecall: null, deltaF1: null, deltaF2: null, verdict: "NO CHANGE" };
  }

  const deltaPrecision = numericDelta(current.precision, baseline.precision);
  const deltaRecall = numericDelta(current.recall, baseline.recall);
  const deltaF1 = numericDelta(current.f1, baseline.f1);
  const deltaF2 = numericDelta(current.f2, baseline.f2);

  let verdict: FamilyVerdict;
  if (current.f2 === null && baseline.f2 === null) {
    verdict = "NO CHANGE";
  } else if (baseline.f2 === null && current.f2 !== null) {
    verdict = "IMPROVED";
  } else if (baseline.f2 !== null && current.f2 === null) {
    verdict = "REGRESSED";
  } else if (deltaF2 !== null && deltaF2 > REGRESSION_EPSILON) {
    verdict = "IMPROVED";
  } else if (deltaF2 !== null && deltaF2 < -REGRESSION_EPSILON) {
    verdict = "REGRESSED";
  } else {
    verdict = "NO CHANGE";
  }

  return { slug, current, baseline, deltaPrecision, deltaRecall, deltaF1, deltaF2, verdict };
}

function compareReports(params: { current: EvaluationReport; baseline: EvaluationReport; baselinePath: string }): ComparisonResult {
  const { current, baseline, baselinePath } = params;

  const currentBySlug = new Map(current.families.map((family) => [family.slug, family]));
  const baselineBySlug = new Map(baseline.families.map((family) => [family.slug, family]));
  const allSlugs = new Set<string>([...currentBySlug.keys(), ...baselineBySlug.keys()]);

  const families = Array.from(allSlugs)
    .sort((a, b) => a.localeCompare(b))
    .map((slug) =>
      compareFamily({ slug, current: currentBySlug.get(slug) ?? null, baseline: baselineBySlug.get(slug) ?? null }),
    );

  const aggregate = compareFamily({ slug: "AGGREGATE", current: current.aggregate, baseline: baseline.aggregate });

  const anyRegressed = aggregate.verdict === "REGRESSED" || families.some((family) => family.verdict === "REGRESSED");
  const anyImproved = aggregate.verdict === "IMPROVED" || families.some((family) => family.verdict === "IMPROVED");
  const overallVerdict: OverallVerdict = anyRegressed ? "REGRESSED" : anyImproved ? "IMPROVED" : "NO CHANGE";

  return { baselinePath, overallVerdict, aggregate, families };
}

function assertIsEvaluationReport(params: { raw: unknown; sourcePath: string }): EvaluationReport {
  const { raw, sourcePath } = params;
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${sourcePath}: not a valid evaluation report (expected a JSON object)`);
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.families) || typeof record.aggregate !== "object" || record.aggregate === null) {
    throw new Error(`${sourcePath}: not a valid evaluation report (missing "families"/"aggregate") — was it produced by this harness?`);
  }
  return raw as EvaluationReport;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmt(value: number | null, digits = 3): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

function deltaCell(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(3)}`;
}

function padCell(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function renderTable(params: { headers: readonly string[]; rows: readonly (readonly string[])[] }): string {
  const { headers, rows } = params;
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => row[i]?.length ?? 0)));
  const renderRow = (cells: readonly string[]): string => cells.map((cell, i) => padCell(cell, widths[i] ?? 0)).join("  ");
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  return [renderRow(headers), separator, ...rows.map(renderRow)].join("\n");
}

function metricsRow(family: FamilyMetrics): string[] {
  return [
    family.slug,
    String(family.tp),
    String(family.fp),
    String(family.fn),
    String(family.tn),
    fmt(family.precision),
    fmt(family.recall),
    fmt(family.f1),
    fmt(family.f2),
    family.status,
  ];
}

function renderHumanReport(report: EvaluationReport): string {
  const lines: string[] = [];
  lines.push("secondpass scan-stage evaluation");
  lines.push(`manifest: ${report.manifestPath}`);
  lines.push(`cases: ${report.evaluatedCases} evaluated, ${report.skippedCases} skipped (of ${report.totalCases} total)`);
  lines.push("");
  lines.push(
    "F2 (recall x2) is the headline number for this stage: a false negative here is invisible forever, a false " +
      "positive is cheap — adjudication filters it. See bench/README.md before optimizing against this table.",
  );
  lines.push("");

  const headers = ["family", "tp", "fp", "fn", "tn", "precision", "recall", "f1", "f2", "status"];
  const rows = [...report.families.map(metricsRow), metricsRow(report.aggregate)];
  lines.push(renderTable({ headers, rows }));

  const needsWork = report.families.filter((family) => family.status === "NEEDS WORK");
  if (needsWork.length > 0) {
    lines.push("");
    lines.push(`NEEDS WORK (${needsWork.length}): ${needsWork.map((family) => family.slug).join(", ")}`);
  }

  const noData = report.families.filter((family) => family.status === "NO DATA");
  if (noData.length > 0) {
    lines.push(`NO DATA — zero corpus cases (${noData.length}): ${noData.map((family) => family.slug).join(", ")}`);
  }

  if (report.skippedReasons.length > 0) {
    lines.push("");
    lines.push("warnings:");
    for (const reason of report.skippedReasons) {
      lines.push(`  - ${reason}`);
    }
  }

  return lines.join("\n");
}

function comparisonRow(comparison: FamilyComparison): string[] {
  return [
    comparison.slug,
    comparison.current ? fmt(comparison.current.precision) : "n/a",
    comparison.baseline ? fmt(comparison.baseline.precision) : "n/a",
    deltaCell(comparison.deltaPrecision),
    comparison.current ? fmt(comparison.current.recall) : "n/a",
    comparison.baseline ? fmt(comparison.baseline.recall) : "n/a",
    deltaCell(comparison.deltaRecall),
    comparison.current ? fmt(comparison.current.f2) : "n/a",
    comparison.baseline ? fmt(comparison.baseline.f2) : "n/a",
    deltaCell(comparison.deltaF2),
    comparison.verdict,
  ];
}

function renderComparison(comparison: ComparisonResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`baseline: ${comparison.baselinePath}`);
  const headers = ["family", "P(now)", "P(base)", "dP", "R(now)", "R(base)", "dR", "F2(now)", "F2(base)", "dF2", "verdict"];
  const rows = [...comparison.families.map(comparisonRow), comparisonRow(comparison.aggregate)];
  lines.push(renderTable({ headers, rows }));
  lines.push("");

  const regressed = comparison.families.filter((family) => family.verdict === "REGRESSED");
  if (regressed.length > 0) {
    lines.push(`REGRESSED families (${regressed.length}): ${regressed.map((family) => family.slug).join(", ")}`);
  }
  lines.push(`OVERALL VERDICT: ${comparison.overallVerdict}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  json: boolean;
  baselinePath?: string;
  savePath?: string;
  help: boolean;
}

const USAGE = `Usage: bun bench/evaluate.ts [options]

Evaluates every matcher this package ships (ALL_MATCHERS)
against the labeled corpus at bench/corpus/manifest.json and reports
precision/recall/F1/F2 per family and in aggregate, plus the raw confusion
matrix behind those rates.

Options:
  --json               Print a machine-readable JSON report instead of a table.
  --baseline <path>     Compare this run against a previously saved run (see
                        --save). Prints per-family deltas and an IMPROVED /
                        REGRESSED / NO CHANGE verdict. Exits non-zero if any
                        family regressed.
  --save <path>         Write this run's report to <path> so a later run can
                        use it as --baseline.
  --help, -h            Show this message.
`;

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { json: false, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--json":
        options.json = true;
        break;
      case "--baseline": {
        const value = args[i + 1];
        if (!value) {
          throw new Error("--baseline requires a path argument");
        }
        options.baselinePath = value;
        i += 1;
        break;
      }
      case "--save": {
        const value = args[i + 1];
        if (!value) {
          throw new Error("--save requires a path argument");
        }
        options.savePath = value;
        i += 1;
        break;
      }
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exit(1);
    return;
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }

  const corpusDir = `${import.meta.dir}/corpus`;
  const manifestPath = `${corpusDir}/manifest.json`;
  const manifestFile = Bun.file(manifestPath);

  if (!(await manifestFile.exists())) {
    console.error(`No corpus manifest found at ${manifestPath}.`);
    console.error(
      'Expected shape: { "cases": [{ "file", "expect": "hit"|"miss", "slug", "line"?, "note"? }] } — ' +
        "this harness is coded against that shape, but the corpus has not landed yet.",
    );
    process.exit(1);
    return;
  }

  let manifest: Manifest;
  try {
    const raw: unknown = await manifestFile.json();
    manifest = parseManifest({ raw, manifestPath });
  } catch (error) {
    console.error(`Failed to parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
    return;
  }

  const report = await computeReport({ manifest, corpusDir, manifestPath });

  let comparison: ComparisonResult | null = null;
  if (options.baselinePath) {
    const baselineFile = Bun.file(options.baselinePath);
    if (!(await baselineFile.exists())) {
      console.error(`Baseline file not found: ${options.baselinePath}`);
      process.exit(1);
      return;
    }
    try {
      const baselineRaw: unknown = await baselineFile.json();
      const baseline = assertIsEvaluationReport({ raw: baselineRaw, sourcePath: options.baselinePath });
      comparison = compareReports({ current: report, baseline, baselinePath: options.baselinePath });
    } catch (error) {
      console.error(`Failed to load baseline ${options.baselinePath}: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
      return;
    }
  }

  if (options.savePath) {
    await Bun.write(options.savePath, JSON.stringify(report, null, 2));
    console.error(`Saved baseline to ${options.savePath}`);
  }

  if (options.json) {
    console.log(JSON.stringify({ report, comparison }, null, 2));
  } else {
    console.log(renderHumanReport(report));
    if (comparison) {
      console.log(renderComparison(comparison));
    }
  }

  process.exit(comparison?.overallVerdict === "REGRESSED" ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
