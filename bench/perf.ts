#!/usr/bin/env bun
/**
 * secondpass performance + ReDoS benchmark suite.
 *
 * Run with `bun bench/perf.ts` (see `bench/PERF.md` for how to read the
 * output and what the tolerances mean). Six measurements, in dependency
 * order:
 *
 *   4. ReDoS guard        — every regex in the composed matcher registry
 *                            against adversarial input, isolated in a
 *                            worker so a genuinely catastrophic pattern
 *                            can be hard-killed instead of wedging this
 *                            script. Runs FIRST: its findings (which
 *                            patterns got killed) gate what section 2/3
 *                            is allowed to run directly against real
 *                            corpus files afterward.
 *   1. Throughput          — files/sec + MB/sec for `scanProject` over a
 *                            large and a small real corpus, cold vs. warm.
 *   2. Per-matcher cost    — ranked total-time / time-per-KB per family.
 *   3. Per-pattern cost    — same, drilled into the top 3 families.
 *   5. Scaling curve       — time vs. synthetic input size, linear or not.
 *   6. Memory              — peak RSS during a full-tree scan.
 *
 * No external dependencies. All timing via `Bun.nanoseconds()`.
 */

import { resolve } from "node:path";
import { scanProject } from "../src/scanner.js";
import { ALL_MATCHERS } from "../src/matchers/index.js";
import { DEFAULT_IGNORE } from "../src/types.js";
import type { Matcher } from "../src/types.js";
import type { WorkerJob, WorkerJobResult } from "./worker-protocol.js";

// ---------------------------------------------------------------------------
// Tunables — every threshold that decides pass/fail or drives an isolation
// timeout lives here, named, so a reader never has to hunt a magic number.
// ---------------------------------------------------------------------------

/** N warm reps per corpus, after discarding the first (JIT warmup) run. */
const WARM_RUN_COUNT = 5;

/**
 * ReDoS FAILURE line (task-suggested value). Any regex that takes longer
 * than this against ANY adversarial input is reported as a failure — this
 * is a correctness gate, not a tuning target.
 */
const REDOS_BUDGET_MS = 50;

/**
 * Worker hard-kill threshold. Comfortably above {@link REDOS_BUDGET_MS} so
 * a merely-slow (but finite) regex is still measured and reported with a
 * real number; only a regex that hasn't returned by this point is presumed
 * genuinely hung and gets `Worker.terminate()`d. This is what makes "hard
 * budget" true regardless of what a specific JS engine's backtracking
 * limiter does or doesn't do.
 */
const REDOS_HARD_KILL_MS = 2_000;

/**
 * Hard-kill threshold for the scaling curve's "scan" jobs. Higher than the
 * ReDoS one on purpose: a legitimate 1 MB scan across every matcher is
 * allowed to take real wall-clock time without being mistaken for a hang.
 */
const SCALING_HARD_KILL_MS = 15_000;

/**
 * Throughput regression tolerance for the --baseline comparison, as a
 * fraction (0.20 = 20%). Wide on purpose: this benchmark runs on a shared
 * dev machine, not isolated CI hardware, and file-system + GC jitter alone
 * can swing a warm median by double digits run to run. A flaky benchmark
 * gets ignored, which is worse than no benchmark — this tolerance is sized
 * so normal noise never trips it, and a REGRESSED verdict means something.
 */
const THROUGHPUT_REGRESSION_TOLERANCE = 0.2;

/** Same idea, applied to informational (non-gating) comparisons. */
const INFO_REGRESSION_TOLERANCE = 0.25;

/**
 * A scaling exponent (see {@link computeExponent}) above this is reported
 * as superlinear. 1.0 is perfectly linear; generous headroom above that
 * absorbs measurement noise at the small end of the curve (sub-millisecond
 * timings are dominated by function-call and GC overhead, not regex cost).
 */
const SCALING_SUPERLINEAR_EXPONENT_THRESHOLD = 1.3;

/** Synthetic source sizes for the scaling curve, per the task spec. */
const SCALING_SIZES_BYTES: readonly number[] = [1_024, 10_240, 102_400, 1_048_576];

/** Reps per scaling-curve size point; report the median. */
const SCALING_REPS = 3;

/** Files above this size are skipped when walking a corpus (mirrors scanner.ts's own cap). */
const MAX_BENCH_FILE_BYTES = 1.5 * 1024 * 1024;

/** How often to sample RSS while a memory-measurement scan is in flight. */
const MEMORY_SAMPLE_INTERVAL_MS = 10;

const BENCH_DIR = import.meta.dir;
const REPO_ROOT = resolve(BENCH_DIR, "..");
/**
 * Defaults are checked into this repo so `bun bench/perf.ts` reproduces
 * anywhere, but they are small. Throughput measured over a few hundred KB
 * says little about a real tree — point `--large` at one to get a number
 * worth recording.
 */
const LARGE_CORPUS_ROOT = resolve(REPO_ROOT, "bench/corpus");
const SMALL_CORPUS_ROOT = resolve(REPO_ROOT, "src/matchers");

// ---------------------------------------------------------------------------
// Shared corpus / matcher helpers
// ---------------------------------------------------------------------------

interface CorpusFile {
  /** Repo-relative to the corpus root, POSIX separators. */
  filePath: string;
  content: string;
  sizeBytes: number;
}

function matcherAppliesLocal(params: {
  matcher: Matcher;
  filePath: string;
  globCache: Map<Matcher, Bun.Glob[]>;
}): boolean {
  const { matcher, filePath, globCache } = params;
  let globs = globCache.get(matcher);
  if (!globs) {
    globs = matcher.filePatterns.map((pattern) => new Bun.Glob(pattern));
    globCache.set(matcher, globs);
  }
  return globs.some((glob) => glob.match(filePath));
}

/**
 * Walk a corpus root exactly the way `scanProject` would (ignore globs,
 * matcher-applicability skip, oversize skip), and keep every file's content
 * resident so sections 2/3 can time regexes against it directly without
 * re-reading the filesystem per pattern.
 */
async function walkCorpus(params: {
  rootAbs: string;
  matchers: readonly Matcher[];
}): Promise<CorpusFile[]> {
  const { rootAbs, matchers } = params;
  const ignoreGlobs = DEFAULT_IGNORE.map((pattern) => new Bun.Glob(pattern));
  const globCache = new Map<Matcher, Bun.Glob[]>();
  const walker = new Bun.Glob("**/*");
  const files: CorpusFile[] = [];

  for await (const relPath of walker.scan({ cwd: rootAbs, dot: false })) {
    const filePath = relPath.replaceAll("\\", "/");
    if (ignoreGlobs.some((glob) => glob.match(filePath))) continue;
    if (!matchers.some((matcher) => matcherAppliesLocal({ matcher, filePath, globCache }))) continue;

    const bunFile = Bun.file(`${rootAbs}/${filePath}`);
    if (bunFile.size > MAX_BENCH_FILE_BYTES) continue;

    const content = await bunFile.text();
    files.push({ filePath, content, sizeBytes: bunFile.size });
  }

  return files;
}

function sumBytes(files: readonly CorpusFile[]): number {
  return files.reduce((total, file) => total + file.sizeBytes, 0);
}

// ---------------------------------------------------------------------------
// Section 4 — ReDoS / catastrophic backtracking guard (runs first)
// ---------------------------------------------------------------------------

function repeatToLength(unit: string, targetLength: number): string {
  const repeats = Math.ceil(targetLength / unit.length);
  return unit.repeat(repeats).slice(0, targetLength);
}

function build100KbSingleLine(): string {
  const token = "const veryLongIdentifierName = someFunctionCall(argumentOne, argumentTwo); ";
  return repeatToLength(token, 100 * 1024);
}

const REDOS_INPUTS: Readonly<Record<string, string>> = {
  "long-runs-of-spaces": " ".repeat(50_000),
  "deeply-nested-template-interp": "${".repeat(20_000),
  "thousands-of-quotes": `${'"'.repeat(10_000)}${"'".repeat(10_000)}`,
  "long-unclosed-braces": "{".repeat(50_000),
  "100kb-single-line-no-newline": build100KbSingleLine(),
};

interface RedosCaseResult {
  matcherSlug: string;
  label: string;
  source: string;
  flags: string;
  inputName: string;
  elapsedMs: number;
  killed: boolean;
  failed: boolean;
}

function spawnBenchWorker(): Worker {
  return new Worker(new URL("./redos-worker.ts", import.meta.url).href);
}

async function runIsolated(params: {
  worker: Worker;
  job: WorkerJob;
  hardKillMs: number;
}): Promise<{ elapsedMs: number; killed: boolean; candidateCount: number | undefined }> {
  const { worker, job, hardKillMs } = params;
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      resolve({ elapsedMs: hardKillMs, killed: true, candidateCount: undefined });
    }, hardKillMs);

    worker.onmessage = (event: MessageEvent<WorkerJobResult>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const data = event.data;
      resolve({
        elapsedMs: data.elapsedMs,
        killed: false,
        candidateCount: data.kind === "scan" ? data.candidateCount : undefined,
      });
    };

    worker.onerror = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve({ elapsedMs: hardKillMs, killed: true, candidateCount: undefined });
    };

    worker.postMessage(job);
  });
}

async function runRedosGuard(params: { matchers: readonly Matcher[] }): Promise<RedosCaseResult[]> {
  const { matchers } = params;
  const results: RedosCaseResult[] = [];
  let worker = spawnBenchWorker();

  for (const matcher of matchers) {
    for (const pattern of matcher.patterns) {
      for (const [inputName, input] of Object.entries(REDOS_INPUTS)) {
        const { elapsedMs, killed } = await runIsolated({
          worker,
          job: { kind: "pattern", source: pattern.regex.source, flags: pattern.regex.flags, input },
          hardKillMs: REDOS_HARD_KILL_MS,
        });
        if (killed) {
          // The worker that just got terminated is dead; the next job
          // needs a fresh one.
          worker = spawnBenchWorker();
        }
        results.push({
          matcherSlug: matcher.slug,
          label: pattern.label,
          source: pattern.regex.source,
          flags: pattern.regex.flags,
          inputName,
          elapsedMs,
          killed,
          failed: killed || elapsedMs > REDOS_BUDGET_MS,
        });
      }
    }
  }

  worker.terminate();
  return results;
}

// ---------------------------------------------------------------------------
// Section 1 — Throughput
// ---------------------------------------------------------------------------

interface CorpusRunStats {
  filesScanned: number;
  candidatesFound: number;
  totalBytes: number;
  durationMs: number;
  filesPerSec: number;
  mbPerSec: number;
}

interface CorpusThroughput {
  corpusPath: string;
  cold: CorpusRunStats;
  warmRuns: CorpusRunStats[];
  warmMedian: CorpusRunStats;
}

function median<T>(items: readonly T[], keyOf: (item: T) => number): T {
  const sorted = [...items].sort((a, b) => keyOf(a) - keyOf(b));
  const mid = sorted[Math.floor(sorted.length / 2)];
  if (mid === undefined) {
    throw new Error("median() called on an empty array");
  }
  return mid;
}

async function measureThroughput(params: {
  rootAbs: string;
  matchers: readonly Matcher[];
  totalBytes: number;
}): Promise<CorpusThroughput> {
  const { rootAbs, matchers, totalBytes } = params;
  const reps: CorpusRunStats[] = [];

  for (let i = 0; i < WARM_RUN_COUNT + 1; i += 1) {
    const start = Bun.nanoseconds();
    const result = await scanProject({
      project: { id: `bench-throughput-${i}`, root: rootAbs },
      matchers,
      runId: `bench-throughput-${i}-${Date.now()}`,
    });
    const durationMs = (Bun.nanoseconds() - start) / 1_000_000;
    const seconds = durationMs / 1000;
    reps.push({
      filesScanned: result.filesScanned,
      candidatesFound: result.candidatesFound,
      totalBytes,
      durationMs,
      filesPerSec: seconds > 0 ? result.filesScanned / seconds : Number.POSITIVE_INFINITY,
      mbPerSec: seconds > 0 ? totalBytes / (1024 * 1024) / seconds : Number.POSITIVE_INFINITY,
    });
  }

  const cold = reps[0];
  if (cold === undefined) {
    throw new Error("measureThroughput produced no reps");
  }
  const warmRuns = reps.slice(1);
  const warmMedian = median(warmRuns, (run) => run.durationMs);

  return { corpusPath: rootAbs, cold, warmRuns, warmMedian };
}

// ---------------------------------------------------------------------------
// Sections 2 & 3 — Per-matcher and per-pattern cost
// ---------------------------------------------------------------------------

interface PatternCost {
  matcherSlug: string;
  label: string;
  source: string;
  totalMs: number;
  msPerKb: number;
  shareOfFamilyPct: number;
  skipped: boolean;
}

interface MatcherCost {
  slug: string;
  noiseTier: string;
  totalMs: number;
  totalBytes: number;
  msPerKb: number;
  fileCount: number;
  shareOfTotalPct: number;
  skippedPatternCount: number;
}

/**
 * Mirrors `scanner.ts`'s `toGlobalRegex` — a fresh, always-global RegExp per
 * (file, pattern) call, so timing here pays the same lastIndex-safety cost
 * production pays, and reflects the real `exec`-loop-until-null shape
 * rather than a single `.test()`.
 */
function toGlobalRegex(regex: RegExp): RegExp {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  return new RegExp(regex.source, flags);
}

function timePatternOverContent(params: { regex: RegExp; content: string }): number {
  const { regex, content } = params;
  const global = toGlobalRegex(regex);
  const start = Bun.nanoseconds();
  let match = global.exec(content);
  while (match !== null) {
    if (match[0].length === 0) {
      global.lastIndex += 1;
    }
    match = global.exec(content);
  }
  return Bun.nanoseconds() - start;
}

function computeMatcherAndPatternCosts(params: {
  files: readonly CorpusFile[];
  matchers: readonly Matcher[];
  killedKeys: ReadonlySet<string>;
}): { matcherCosts: MatcherCost[]; patternCostsByMatcher: Map<string, PatternCost[]> } {
  const { files, matchers, killedKeys } = params;
  const globCache = new Map<Matcher, Bun.Glob[]>();
  const matcherCosts: MatcherCost[] = [];
  const patternCostsByMatcher = new Map<string, PatternCost[]>();

  for (const matcher of matchers) {
    const applicableFiles = files.filter((file) =>
      matcherAppliesLocal({ matcher, filePath: file.filePath, globCache }),
    );
    const totalBytes = sumBytes(applicableFiles);

    const patternCosts: PatternCost[] = [];
    let matcherTotalNs = 0;
    let skippedPatternCount = 0;

    for (const pattern of matcher.patterns) {
      const key = `${matcher.slug}::${pattern.label}`;
      if (killedKeys.has(key)) {
        // This exact pattern hard-timed-out against adversarial input in
        // the isolated worker (section 4). Do not run it against real
        // files on the main thread — that is precisely the situation the
        // isolation exists to prevent from reaching the main process.
        patternCosts.push({
          matcherSlug: matcher.slug,
          label: pattern.label,
          source: pattern.regex.source,
          totalMs: 0,
          msPerKb: 0,
          shareOfFamilyPct: 0,
          skipped: true,
        });
        skippedPatternCount += 1;
        continue;
      }

      let patternNs = 0;
      for (const file of applicableFiles) {
        patternNs += timePatternOverContent({ regex: pattern.regex, content: file.content });
      }
      matcherTotalNs += patternNs;
      patternCosts.push({
        matcherSlug: matcher.slug,
        label: pattern.label,
        source: pattern.regex.source,
        totalMs: patternNs / 1_000_000,
        msPerKb: totalBytes > 0 ? patternNs / 1_000_000 / (totalBytes / 1024) : 0,
        shareOfFamilyPct: 0,
        skipped: false,
      });
    }

    for (const patternCost of patternCosts) {
      if (!patternCost.skipped) {
        patternCost.shareOfFamilyPct =
          matcherTotalNs > 0 ? ((patternCost.totalMs * 1_000_000) / matcherTotalNs) * 100 : 0;
      }
    }
    patternCosts.sort((a, b) => b.totalMs - a.totalMs);
    patternCostsByMatcher.set(matcher.slug, patternCosts);

    matcherCosts.push({
      slug: matcher.slug,
      noiseTier: matcher.noiseTier,
      totalMs: matcherTotalNs / 1_000_000,
      totalBytes,
      msPerKb: totalBytes > 0 ? matcherTotalNs / 1_000_000 / (totalBytes / 1024) : 0,
      fileCount: applicableFiles.length,
      shareOfTotalPct: 0,
      skippedPatternCount,
    });
  }

  const grandTotalMs = matcherCosts.reduce((total, matcher) => total + matcher.totalMs, 0);
  for (const matcherCost of matcherCosts) {
    matcherCost.shareOfTotalPct = grandTotalMs > 0 ? (matcherCost.totalMs / grandTotalMs) * 100 : 0;
  }
  matcherCosts.sort((a, b) => b.totalMs - a.totalMs);

  return { matcherCosts, patternCostsByMatcher };
}

// ---------------------------------------------------------------------------
// Section 5 — Scaling curve
// ---------------------------------------------------------------------------

interface ScalingPoint {
  sizeBytes: number;
  medianMs: number;
  msPerKb: number;
}

interface ScalingExponent {
  fromBytes: number;
  toBytes: number;
  exponent: number;
}

interface ScalingReport {
  points: ScalingPoint[];
  exponents: ScalingExponent[];
  verdict: "linear" | "superlinear";
}

function buildSyntheticSource(targetBytes: number): string {
  const parts: string[] = [];
  let bytes = 0;
  let i = 0;
  while (bytes < targetBytes) {
    const line = `function handler_${i}(req) { const result = compute(req.params, req.query, req.body); return result ?? fallback_${i}; }\n`;
    parts.push(line);
    bytes += line.length; // ASCII source, 1 byte per char
    i += 1;
  }
  const content = parts.join("");
  return content.length > targetBytes ? content.slice(0, targetBytes) : content;
}

/** Minimum ms floor before a timing enters an exponent calculation — avoids log(~0) noise. */
const MIN_MS_FOR_EXPONENT = 0.05;

function computeExponent(params: {
  fromBytes: number;
  toBytes: number;
  fromMs: number;
  toMs: number;
}): number {
  const { fromBytes, toBytes, fromMs, toMs } = params;
  const t1 = Math.max(fromMs, MIN_MS_FOR_EXPONENT);
  const t2 = Math.max(toMs, MIN_MS_FOR_EXPONENT);
  return Math.log(t2 / t1) / Math.log(toBytes / fromBytes);
}

async function runScalingCurve(): Promise<ScalingReport> {
  const points: ScalingPoint[] = [];
  let worker = spawnBenchWorker();

  for (const sizeBytes of SCALING_SIZES_BYTES) {
    const content = buildSyntheticSource(sizeBytes);
    const reps: number[] = [];
    for (let i = 0; i < SCALING_REPS; i += 1) {
      const { elapsedMs, killed } = await runIsolated({
        worker,
        job: { kind: "scan", content },
        hardKillMs: SCALING_HARD_KILL_MS,
      });
      if (killed) {
        worker = spawnBenchWorker();
      }
      reps.push(elapsedMs);
    }
    const medianMs = median(reps, (ms) => ms);
    points.push({ sizeBytes, medianMs, msPerKb: medianMs / (sizeBytes / 1024) });
  }

  worker.terminate();

  const exponents: ScalingExponent[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    if (!prev || !curr) continue;
    exponents.push({
      fromBytes: prev.sizeBytes,
      toBytes: curr.sizeBytes,
      exponent: computeExponent({
        fromBytes: prev.sizeBytes,
        toBytes: curr.sizeBytes,
        fromMs: prev.medianMs,
        toMs: curr.medianMs,
      }),
    });
  }

  const verdict: ScalingReport["verdict"] = exponents.some(
    (e) => e.exponent > SCALING_SUPERLINEAR_EXPONENT_THRESHOLD,
  )
    ? "superlinear"
    : "linear";

  return { points, exponents, verdict };
}

// ---------------------------------------------------------------------------
// Section 6 — Memory
// ---------------------------------------------------------------------------

interface MemoryReport {
  corpusPath: string;
  rssBeforeMb: number;
  rssAfterMb: number;
  peakRssMb: number;
  deltaFromBeforeMb: number;
}

async function measurePeakMemory(params: {
  rootAbs: string;
  matchers: readonly Matcher[];
}): Promise<MemoryReport> {
  const { rootAbs, matchers } = params;

  if (typeof Bun.gc === "function") {
    Bun.gc(true);
  }
  await new Promise((r) => setTimeout(r, 20));

  const rssBefore = process.memoryUsage().rss;
  let peakRss = rssBefore;
  const interval = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  }, MEMORY_SAMPLE_INTERVAL_MS);

  try {
    await scanProject({
      project: { id: "bench-memory", root: rootAbs },
      matchers,
      runId: `bench-memory-${Date.now()}`,
    });
  } finally {
    clearInterval(interval);
  }

  const rssAfter = process.memoryUsage().rss;
  if (rssAfter > peakRss) peakRss = rssAfter;

  const toMb = (bytes: number): number => bytes / (1024 * 1024);
  return {
    corpusPath: rootAbs,
    rssBeforeMb: toMb(rssBefore),
    rssAfterMb: toMb(rssAfter),
    peakRssMb: toMb(peakRss),
    deltaFromBeforeMb: toMb(peakRss - rssBefore),
  };
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

interface BenchReport {
  meta: {
    generatedAt: string;
    bunVersion: string;
    platform: string;
    matcherCount: number;
    patternCount: number;
    largeCorpusPath: string;
    smallCorpusPath: string;
  };
  throughput: { large: CorpusThroughput; small: CorpusThroughput };
  matcherCosts: MatcherCost[];
  topFamilyPatternCosts: Array<{ matcherSlug: string; patterns: PatternCost[] }>;
  redos: { budgetMs: number; hardKillMs: number; cases: RedosCaseResult[]; failures: RedosCaseResult[] };
  scaling: ScalingReport;
  memory: MemoryReport;
}

async function buildReport(params: { largeRoot: string; smallRoot: string }): Promise<BenchReport> {
  const { largeRoot, smallRoot } = params;
  const fullMatchers = ALL_MATCHERS;
  const patternCount = fullMatchers.reduce((total, m) => total + m.patterns.length, 0);

  // Section 4 runs first: its failures gate what 2/3 may run on real files.
  const redosResults = await runRedosGuard({ matchers: fullMatchers });
  const killedKeys = new Set(
    redosResults.filter((r) => r.killed).map((r) => `${r.matcherSlug}::${r.label}`),
  );

  const largeFiles = await walkCorpus({ rootAbs: largeRoot, matchers: fullMatchers });
  const smallFiles = await walkCorpus({ rootAbs: smallRoot, matchers: fullMatchers });

  const largeThroughput = await measureThroughput({
    rootAbs: largeRoot,
    matchers: fullMatchers,
    totalBytes: sumBytes(largeFiles),
  });
  const smallThroughput = await measureThroughput({
    rootAbs: smallRoot,
    matchers: fullMatchers,
    totalBytes: sumBytes(smallFiles),
  });

  const { matcherCosts, patternCostsByMatcher } = computeMatcherAndPatternCosts({
    files: largeFiles,
    matchers: fullMatchers,
    killedKeys,
  });

  const topFamilyPatternCosts = matcherCosts.slice(0, 3).map((matcher) => ({
    matcherSlug: matcher.slug,
    patterns: patternCostsByMatcher.get(matcher.slug) ?? [],
  }));

  const scaling = await runScalingCurve();
  const memory = await measurePeakMemory({ rootAbs: largeRoot, matchers: fullMatchers });

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      bunVersion: Bun.version,
      platform: `${process.platform}/${process.arch}`,
      matcherCount: fullMatchers.length,
      patternCount,
      largeCorpusPath: largeRoot,
      smallCorpusPath: smallRoot,
    },
    throughput: { large: largeThroughput, small: smallThroughput },
    matcherCosts,
    topFamilyPatternCosts,
    redos: {
      budgetMs: REDOS_BUDGET_MS,
      hardKillMs: REDOS_HARD_KILL_MS,
      cases: redosResults,
      failures: redosResults.filter((r) => r.failed),
    },
    scaling,
    memory,
  };
}

// ---------------------------------------------------------------------------
// Baseline comparison
// ---------------------------------------------------------------------------

type Verdict = "IMPROVED" | "REGRESSED" | "NO CHANGE";

interface Comparison {
  label: string;
  current: number;
  baseline: number;
  deltaPct: number;
  verdict: Verdict;
  gating: boolean;
}

function compareMetric(params: {
  label: string;
  current: number;
  baseline: number;
  tolerance: number;
  higherIsBetter: boolean;
  gating: boolean;
}): Comparison {
  const { label, current, baseline, tolerance, higherIsBetter, gating } = params;
  if (baseline === 0 || !Number.isFinite(baseline)) {
    return { label, current, baseline, deltaPct: 0, verdict: "NO CHANGE", gating };
  }
  const rawDeltaPct = (current - baseline) / baseline;
  const signedDeltaPct = higherIsBetter ? rawDeltaPct : -rawDeltaPct;
  const verdict: Verdict =
    Math.abs(rawDeltaPct) <= tolerance ? "NO CHANGE" : signedDeltaPct > 0 ? "IMPROVED" : "REGRESSED";
  return { label, current, baseline, deltaPct: rawDeltaPct, verdict, gating };
}

function isBenchReport(value: unknown): value is BenchReport {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.throughput === "object" &&
    typeof record.matcherCosts === "object" &&
    typeof record.redos === "object" &&
    typeof record.scaling === "object" &&
    typeof record.memory === "object"
  );
}

async function loadBaseline(path: string): Promise<BenchReport | undefined> {
  try {
    const raw: unknown = await Bun.file(path).json();
    if (!isBenchReport(raw)) {
      console.error(`--baseline ${path}: file does not look like a bench report, ignoring.`);
      return undefined;
    }
    return raw;
  } catch (error) {
    console.error(`--baseline ${path}: could not read/parse (${errorMessage(error)}), ignoring.`);
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildComparisons(params: { current: BenchReport; baseline: BenchReport }): Comparison[] {
  const { current, baseline } = params;
  const totalCurrentMs = current.matcherCosts.reduce((n, m) => n + m.totalMs, 0);
  const totalBaselineMs = baseline.matcherCosts.reduce((n, m) => n + m.totalMs, 0);
  const scaling1MbCurrent = current.scaling.points.at(-1);
  const scaling1MbBaseline = baseline.scaling.points.at(-1);

  const comparisons: Comparison[] = [
    compareMetric({
      label: "large corpus files/sec (warm median)",
      current: current.throughput.large.warmMedian.filesPerSec,
      baseline: baseline.throughput.large.warmMedian.filesPerSec,
      tolerance: THROUGHPUT_REGRESSION_TOLERANCE,
      higherIsBetter: true,
      gating: true,
    }),
    compareMetric({
      label: "large corpus MB/sec (warm median)",
      current: current.throughput.large.warmMedian.mbPerSec,
      baseline: baseline.throughput.large.warmMedian.mbPerSec,
      tolerance: INFO_REGRESSION_TOLERANCE,
      higherIsBetter: true,
      gating: false,
    }),
    compareMetric({
      label: "small corpus files/sec (warm median)",
      current: current.throughput.small.warmMedian.filesPerSec,
      baseline: baseline.throughput.small.warmMedian.filesPerSec,
      tolerance: THROUGHPUT_REGRESSION_TOLERANCE,
      higherIsBetter: true,
      gating: true,
    }),
    compareMetric({
      label: "total matcher regex time (large corpus)",
      current: totalCurrentMs,
      baseline: totalBaselineMs,
      tolerance: INFO_REGRESSION_TOLERANCE,
      higherIsBetter: false,
      gating: false,
    }),
    compareMetric({
      label: "peak RSS during full-tree scan",
      current: current.memory.peakRssMb,
      baseline: baseline.memory.peakRssMb,
      tolerance: INFO_REGRESSION_TOLERANCE,
      higherIsBetter: false,
      gating: false,
    }),
  ];

  if (scaling1MbCurrent && scaling1MbBaseline) {
    comparisons.push(
      compareMetric({
        label: "scaling curve ms/KB @ 1 MB",
        current: scaling1MbCurrent.msPerKb,
        baseline: scaling1MbBaseline.msPerKb,
        tolerance: INFO_REGRESSION_TOLERANCE,
        higherIsBetter: false,
        gating: false,
      }),
    );
  }

  return comparisons;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  json: boolean;
  baselinePath: string | undefined;
  savePath: string | undefined;
  largeRoot: string;
  smallRoot: string;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let json = false;
  let baselinePath: string | undefined;
  let savePath: string | undefined;
  let largeRoot = LARGE_CORPUS_ROOT;
  let smallRoot = SMALL_CORPUS_ROOT;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--baseline") {
      baselinePath = argv[i + 1];
      i += 1;
    } else if (arg === "--save") {
      savePath = argv[i + 1];
      i += 1;
    } else if (arg === "--large") {
      largeRoot = resolve(argv[i + 1] ?? largeRoot);
      i += 1;
    } else if (arg === "--small") {
      smallRoot = resolve(argv[i + 1] ?? smallRoot);
      i += 1;
    }
  }

  return { json, baselinePath, savePath, largeRoot, smallRoot, help };
}

function printHelp(): void {
  console.log(`secondpass performance + ReDoS benchmark

Usage: bun bench/perf.ts [options]

Options:
  --json               Print machine-readable JSON instead of tables.
  --baseline <path>    Compare this run against a previously --save'd report.
  --save <path>        Write this run's report as JSON to <path>.
  --large <path>       Large-corpus root (default: bench/corpus). Point this
                       at a real source tree for a throughput number worth
                       recording — the checked-in default is only ~400 KB.
  --small <path>       Small-corpus root (default: src/matchers).
  --help, -h            Show this help.

Exit code is non-zero on any ReDoS FAILURE, or a throughput regression
beyond the tolerance stated in bench/PERF.md. See bench/PERF.md for the
full guide to reading the output.`);
}

// ---------------------------------------------------------------------------
// Human-readable formatting
// ---------------------------------------------------------------------------

function renderTable(params: { headers: readonly string[]; rows: readonly (readonly string[])[] }): string {
  const { headers, rows } = params;
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const renderRow = (cells: readonly string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ");
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  return [renderRow(headers), separator, ...rows.map(renderRow)].join("\n");
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(ms < 10 ? 3 : 1)}`;
}

function fmtRate(rate: number): string {
  return Number.isFinite(rate) ? rate.toFixed(1) : "inf";
}

function fmtPct(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

function fmtMb(mb: number): string {
  return `${mb.toFixed(2)} MB`;
}

function printThroughputSection(report: BenchReport): void {
  console.log("\n== 1. Throughput (scanProject) ==\n");
  const rows = (["large", "small"] as const).map((size) => {
    const t = report.throughput[size];
    return [
      `${size} (${t.cold.filesScanned} files)`,
      fmtMs(t.cold.durationMs),
      fmtMs(t.warmMedian.durationMs),
      fmtRate(t.cold.filesPerSec),
      fmtRate(t.warmMedian.filesPerSec),
      fmtRate(t.warmMedian.mbPerSec),
    ];
  });
  console.log(
    renderTable({
      headers: ["Corpus", "Cold ms", "Warm median ms", "Cold files/s", "Warm files/s", "Warm MB/s"],
      rows,
    }),
  );
  console.log(
    `\n(warm median of ${WARM_RUN_COUNT} reps, first run discarded as JIT warmup)`,
  );
}

function printMatcherCostSection(report: BenchReport): void {
  console.log("\n== 2. Per-matcher cost (ranked, most expensive first) ==\n");
  const rows = report.matcherCosts.map((m, i) => [
    String(i + 1),
    m.slug,
    m.noiseTier,
    fmtMs(m.totalMs),
    m.msPerKb.toFixed(4),
    fmtPct(m.shareOfTotalPct),
    String(m.fileCount),
    m.skippedPatternCount > 0 ? `${m.skippedPatternCount} SKIPPED (ReDoS)` : "",
  ]);
  console.log(
    renderTable({
      headers: ["#", "Slug", "Tier", "Total ms", "ms/KB", "Share", "Files", "Note"],
      rows,
    }),
  );
}

function printPatternCostSection(report: BenchReport): void {
  console.log("\n== 3. Per-pattern cost within the top 3 families ==");
  for (const family of report.topFamilyPatternCosts) {
    console.log(`\n-- ${family.matcherSlug} --`);
    const rows = family.patterns.map((p, i) => [
      String(i + 1),
      p.label,
      p.skipped ? "SKIPPED (ReDoS)" : fmtMs(p.totalMs),
      p.skipped ? "" : p.msPerKb.toFixed(4),
      p.skipped ? "" : fmtPct(p.shareOfFamilyPct),
    ]);
    console.log(
      renderTable({ headers: ["#", "Label", "Total ms", "ms/KB", "Share of family"], rows }),
    );
  }
}

function printRedosSection(report: BenchReport): void {
  const { redos } = report;
  console.log(
    `\n== 4. ReDoS guard (budget ${redos.budgetMs}ms, hard-kill ${redos.hardKillMs}ms, ${redos.cases.length} cases) ==\n`,
  );
  if (redos.failures.length === 0) {
    console.log("No failures. Every regex in the composed registry finished every adversarial input within budget.");
    return;
  }
  console.log(`${redos.failures.length} FAILURE(S):\n`);
  const rows = redos.failures.map((f) => [
    f.matcherSlug,
    f.label,
    f.inputName,
    `${fmtMs(f.elapsedMs)}ms${f.killed ? " (KILLED — worker hard-timeout)" : ""}`,
    `/${f.source}/${f.flags}`,
  ]);
  console.log(renderTable({ headers: ["Matcher", "Pattern label", "Input", "Elapsed", "Source"], rows }));
}

function printScalingSection(report: BenchReport): void {
  console.log("\n== 5. Scaling curve (synthetic source) ==\n");
  const rows = report.scaling.points.map((p) => {
    const exponent = report.scaling.exponents.find((e) => e.toBytes === p.sizeBytes);
    return [
      `${(p.sizeBytes / 1024).toFixed(0)} KB`,
      fmtMs(p.medianMs),
      p.msPerKb.toFixed(4),
      exponent ? exponent.exponent.toFixed(2) : "-",
    ];
  });
  console.log(renderTable({ headers: ["Size", "Median ms", "ms/KB", "Exponent vs prev"], rows }));
  console.log(
    `\nVerdict: ${report.scaling.verdict.toUpperCase()}` +
      (report.scaling.verdict === "superlinear"
        ? ` — an exponent above ${SCALING_SUPERLINEAR_EXPONENT_THRESHOLD} means a pattern is backtracking; this is a bug, not a tuning opportunity.`
        : ""),
  );
}

function printMemorySection(report: BenchReport): void {
  console.log("\n== 6. Memory (peak RSS during full-tree scan, large corpus) ==\n");
  const { memory } = report;
  console.log(
    `RSS before: ${fmtMb(memory.rssBeforeMb)}   RSS after: ${fmtMb(memory.rssAfterMb)}   ` +
      `Peak RSS: ${fmtMb(memory.peakRssMb)}   Delta from before: ${fmtMb(memory.deltaFromBeforeMb)}`,
  );
}

function printComparisonSection(comparisons: readonly Comparison[]): void {
  if (comparisons.length === 0) return;
  console.log("\n== Baseline comparison ==\n");
  const rows = comparisons.map((c) => [
    c.label,
    c.current.toFixed(3),
    c.baseline.toFixed(3),
    `${c.deltaPct >= 0 ? "+" : ""}${(c.deltaPct * 100).toFixed(1)}%`,
    c.verdict,
    c.gating ? "(gating)" : "",
  ]);
  console.log(renderTable({ headers: ["Metric", "Current", "Baseline", "Delta", "Verdict", ""], rows }));
}

function printHumanReport(params: { report: BenchReport; comparisons: readonly Comparison[] }): void {
  const { report, comparisons } = params;
  console.log("secondpass performance + ReDoS benchmark");
  console.log(
    `generated ${report.meta.generatedAt} · bun ${report.meta.bunVersion} · ${report.meta.platform} · ` +
      `${report.meta.matcherCount} matchers / ${report.meta.patternCount} patterns`,
  );
  console.log(`large corpus: ${report.meta.largeCorpusPath}`);
  console.log(`small corpus: ${report.meta.smallCorpusPath}`);

  // ReDoS first, matching the run order — it's the correctness gate.
  printRedosSection(report);
  printThroughputSection(report);
  printMatcherCostSection(report);
  printPatternCostSection(report);
  printScalingSection(report);
  printMemorySection(report);
  printComparisonSection(comparisons);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const report = await buildReport({ largeRoot: options.largeRoot, smallRoot: options.smallRoot });

  let comparisons: Comparison[] = [];
  if (options.baselinePath) {
    const baseline = await loadBaseline(options.baselinePath);
    if (baseline) {
      comparisons = buildComparisons({ current: report, baseline });
    }
  }

  if (options.savePath) {
    await Bun.write(options.savePath, JSON.stringify(report, null, 2));
    if (!options.json) {
      console.log(`Saved report to ${options.savePath}`);
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ report, comparisons }, null, 2));
  } else {
    printHumanReport({ report, comparisons });
  }

  const hasRedosFailure = report.redos.failures.length > 0;
  const hasThroughputRegression = comparisons.some((c) => c.gating && c.verdict === "REGRESSED");

  if (hasRedosFailure || hasThroughputRegression) {
    if (!options.json) {
      console.log("\nRESULT: FAIL");
      if (hasRedosFailure) {
        console.log(`  - ${report.redos.failures.length} ReDoS failure(s) — hard blocker, never a "known issue".`);
      }
      if (hasThroughputRegression) {
        console.log("  - throughput regressed beyond tolerance vs. baseline.");
      }
    }
    process.exitCode = 1;
    return;
  }

  if (!options.json) {
    console.log("\nRESULT: PASS");
  }
  process.exitCode = 0;
}

await main();
