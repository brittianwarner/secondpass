#!/usr/bin/env bun
/**
 * secondpass end-to-end runner — drives the whole pipeline against a real
 * project: scan -> batch candidates -> build prompts -> adjudicate -> parse
 * findings -> report. Three modes, selected by `--mode`:
 *
 *   dry     (DEFAULT) Everything except the model call. Scans, batches,
 *           builds every prompt, and reports prompt sizes / estimated
 *           tokens / estimated cost. Fully offline, costs nothing. This is
 *           the default so nobody accidentally spends money running the
 *           script bare.
 *   replay  Adjudication served from recorded fixtures in
 *           `bench/fixtures/responses/*.json`, keyed by a hash of the
 *           system+user prompt. Deterministic, offline, free — the CI /
 *           regression mode. A prompt with no fixture is reported by name,
 *           never silently sent live.
 *   live    Real adjudication through `adjudicateInSandbox`/`adjudicateBatch`
 *           (`../src/sandbox/agentos-runner.ts`). Requires `--yes-spend` in
 *           addition to `--mode live`; prints the estimated cost and
 *           candidate count before doing anything; refuses to run without
 *           the flag or without the configured credential env var present.
 *           `--max-cost-usd` is a hard stop checked before the first batch
 *           AND between every batch. `--record` saves live responses as new
 *           replay fixtures.
 *
 * Usage: `bun bench/e2e.ts [flags]` (also wired as `bun run bench:e2e`).
 * Run `bun bench/e2e.ts --help` for the full flag list. Full docs, the
 * cost-safety design, and how to read the report: `bench/E2E.md`.
 *
 * Style: strict TypeScript, no external dependencies, `Bun.argv` /
 * `Bun.file` / `Bun.write` for I/O, `.js` relative imports (this package's
 * ESM convention — the extension refers to the compiled output, not the
 * `.ts` source on disk).
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Candidate, Finding, NoiseTier, ProjectConfig, ScannedFile, Severity, Verdict } from "../src/types.js";
import { scanProject } from "../src/scanner.js";
import { ALL_MATCHERS } from "../src/matchers/index.js";
import { ADJUDICATION_SYSTEM_PROMPT, batchCandidates, buildAdjudicationPrompt, parseAdjudicationResponse } from "../src/adjudication.js";
import { adjudicateBatch, type SecondpassSandboxOptions } from "../src/sandbox/agentos-runner.js";

// ---------------------------------------------------------------------------
// Paths & defaults
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** bench/ -> repo root is one level up. */
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
/**
 * The checked-in demo project the replay fixtures were recorded against, so
 * `bun bench/e2e.ts` with no flags is reproducible on any machine. Point
 * `--project` at real code to scan something that matters.
 */
const DEFAULT_PROJECT_ROOT = join(SCRIPT_DIR, "fixtures/demo-project");
const DEFAULT_FIXTURES_DIR = join(SCRIPT_DIR, "fixtures/responses");

const DEFAULT_MAX_CANDIDATES_PER_BATCH = 20;
const DEFAULT_API_KEY_ENV = "ANTHROPIC_API_KEY";
/**
 * pi's built-in-catalog default for the anthropic provider — see
 * `DEFAULT_MODEL_BY_PI_PROVIDER.anthropic` in `../src/sandbox/agentos-runner.ts`.
 * Kept in sync by hand (that module deliberately hand-rolls its own local
 * types rather than exporting this constant); used only to pick a pricing
 * row when the caller doesn't pass `--model`.
 */
const DEFAULT_SANDBOX_MODEL_ID = "claude-sonnet-4-5";
/**
 * Heuristic, not a tokenizer: ~4 characters/token is the standard rough
 * estimate for English + code mixed content. Good enough to size a prompt
 * and ballpark a cost; not a substitute for real usage accounting (which
 * `adjudicateInSandbox`/`adjudicateBatch` do not currently return — see
 * bench/E2E.md).
 */
const CHARS_PER_TOKEN_ESTIMATE = 4;
/**
 * Heuristic estimate of one finding's JSON object size in output tokens
 * (vulnSlug, lineNumbers, verdict, severity, summary, rationale,
 * failureScenario, confidence). Used only for the dry-mode/pre-flight cost
 * estimate, never to validate a real response.
 */
const ESTIMATED_OUTPUT_TOKENS_PER_FINDING = 200;
/** A family needs at least this many adjudicated candidates before a 0%-confirmed rate is treated as a signal instead of noise. */
const LARGE_SAMPLE_THRESHOLD = 5;
/** How many of the largest prompts to list individually in the report. */
const TOP_PROMPTS_SHOWN = 5;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Mode = "dry" | "replay" | "live";
const KNOWN_MODES: readonly Mode[] = ["dry", "replay", "live"];

class UsageError extends Error {}

interface CliArgs {
  mode: Mode;
  help: boolean;
  json: boolean;
  out?: string;
  projectRoot: string;
  projectId: string;
  info?: string;
  maxCandidatesPerBatch: number;
  limitFiles?: number;
  fixturesDir: string;
  // live-only
  yesSpend: boolean;
  maxCostUsd?: number;
  record: boolean;
  model?: string;
  apiKeyEnv: string;
  workspaceId: string;
  concurrency?: number;
  timeoutMs?: number;
  // cost-estimator overrides (dry, live pre-flight)
  priceInput?: number;
  priceOutput?: number;
}

function printHelp(): void {
  console.log(
    [
      "secondpass bench/e2e.ts — end-to-end scan -> batch -> prompt -> adjudicate -> report runner",
      "",
      "Usage: bun bench/e2e.ts [--mode dry|replay|live] [flags]",
      "",
      "Modes",
      "  --mode dry      (default) No model call. Scans, batches, builds every prompt, reports sizes/tokens/estimated cost.",
      "  --mode replay   Adjudicate from recorded fixtures in --fixtures-dir. Deterministic, offline, free. CI mode.",
      "  --mode live     Real adjudication via agentOS. Requires --yes-spend. Never the default.",
      "",
      "General",
      "  --project <path>            Project root to scan (default: bench/fixtures/demo-project)",
      "  --project-id <id>           Namespaces the run (default: derived from --project)",
      "  --info <path>               Optional INFO.md-style file injected into every adjudication prompt",
      "  --max-candidates-per-batch  Candidates per batching round (default: 20)",
      "  --limit-files <n>           Only process the first n files that have candidates",
      "  --fixtures-dir <path>       Replay fixture directory (default: bench/fixtures/responses)",
      "  --json                      Emit the report as JSON on stdout instead of human-readable text",
      "  --out <path>                Also write a Markdown findings report to this path",
      "  --price-input <usd/MTok>    Override the input token price used for cost estimates",
      "  --price-output <usd/MTok>   Override the output token price used for cost estimates",
      "  --help                      Show this help",
      "",
      "Live mode only (cost safety)",
      "  --yes-spend                 REQUIRED to actually run live — this call may spend real money",
      "  --max-cost-usd <n>          Hard stop: refuses to start over this estimate, and re-checks between every batch",
      "  --record                    Save each live response as a new replay fixture",
      "  --model <id>                Model id forwarded to the sandbox (default: agentOS/pi's own default)",
      "  --api-key-env <NAME>        Env var NAME holding the model credential (default: ANTHROPIC_API_KEY) — value is never read by this flag, only checked for presence",
      "  --workspace-id <id>         Sandbox workspace scope (default: a generated id)",
      "  --concurrency <n>           Concurrent adjudication sessions per batch (forwarded to adjudicateBatch)",
      "  --timeout-ms <n>            Per-VM timeout forwarded to the sandbox",
      "",
      "Examples",
      "  bun bench/e2e.ts",
      "  bun bench/e2e.ts --mode dry --project ../../apps/web/src --json",
      "  bun bench/e2e.ts --mode replay --out bench/e2e-report.md",
      "  bun bench/e2e.ts --mode live --yes-spend --max-cost-usd 2.00 --limit-files 5 --record",
    ].join("\n"),
  );
}

function parseNumberFlag(params: { name: string; raw: string }): number {
  const value = Number(params.raw);
  if (!Number.isFinite(value)) {
    throw new UsageError(`--${params.name} expects a number, got "${params.raw}"`);
  }
  return value;
}

function parseArgs(argv: string[]): CliArgs {
  const raw = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) continue;
    const eqIndex = token.indexOf("=");
    if (eqIndex !== -1) {
      raw.set(token.slice(2, eqIndex), token.slice(eqIndex + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      raw.set(key, next);
      i += 1;
    } else {
      raw.set(key, true);
    }
  }

  const str = (key: string): string | undefined => {
    const value = raw.get(key);
    return typeof value === "string" ? value : undefined;
  };
  const flag = (key: string): boolean => raw.has(key);
  const num = (key: string): number | undefined => {
    const value = str(key);
    return value === undefined ? undefined : parseNumberFlag({ name: key, raw: value });
  };

  const modeRaw = str("mode") ?? "dry";
  if (!(KNOWN_MODES as readonly string[]).includes(modeRaw)) {
    throw new UsageError(`--mode must be one of ${KNOWN_MODES.join(", ")}, got "${modeRaw}"`);
  }
  const mode = modeRaw as Mode;

  const projectRoot = resolve(str("project") ?? DEFAULT_PROJECT_ROOT);

  return {
    mode,
    help: flag("help"),
    json: flag("json"),
    out: str("out"),
    projectRoot,
    projectId: str("project-id") ?? defaultProjectId(projectRoot),
    info: str("info"),
    maxCandidatesPerBatch: num("max-candidates-per-batch") ?? DEFAULT_MAX_CANDIDATES_PER_BATCH,
    limitFiles: num("limit-files"),
    fixturesDir: resolve(str("fixtures-dir") ?? DEFAULT_FIXTURES_DIR),
    yesSpend: flag("yes-spend"),
    maxCostUsd: num("max-cost-usd"),
    record: flag("record"),
    model: str("model"),
    apiKeyEnv: str("api-key-env") ?? DEFAULT_API_KEY_ENV,
    workspaceId: str("workspace-id") ?? `secondpass-e2e-${randomUUID()}`,
    concurrency: num("concurrency"),
    timeoutMs: num("timeout-ms"),
    priceInput: num("price-input"),
    priceOutput: num("price-output"),
  };
}

function defaultProjectId(root: string): string {
  const rel = relative(REPO_ROOT, root) || basename(root);
  const trimmed = rel.replace(/\/src$/, "").replace(/\\/g, "/");
  const slug = trimmed.replace(/[\\/]+/g, "-").replace(/[^a-zA-Z0-9._-]/g, "-");
  return slug.length > 0 ? slug : "target";
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

interface PricingInfo {
  modelLabel: string;
  inputPerMTok: number;
  outputPerMTok: number;
  /** True when the rate is a stand-in (unknown model id, priced at the nearest known tier) rather than a confirmed rate-card entry. */
  approximated: boolean;
}

/**
 * Anthropic first-party API rates, USD per 1M tokens (cached 2026-06-24).
 * `claude-sonnet-4-5` — the sandbox transport's actual default model
 * (`DEFAULT_MODEL_BY_PI_PROVIDER.anthropic` in agentos-runner.ts) — is not on
 * the current rate card; it is priced here at the Sonnet-5/4.6 rate as the
 * closest known analog and flagged `approximated` below. Override with
 * `--price-input`/`--price-output` for an exact figure.
 */
const MODEL_PRICING_USD_PER_MTOK: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const SONNET_FALLBACK_RATE = MODEL_PRICING_USD_PER_MTOK["claude-sonnet-4-6"]!;

function resolvePricing(params: { modelId?: string; overrideInput?: number; overrideOutput?: number }): PricingInfo {
  const { modelId, overrideInput, overrideOutput } = params;
  const resolvedId = modelId ?? DEFAULT_SANDBOX_MODEL_ID;
  const known = MODEL_PRICING_USD_PER_MTOK[resolvedId];
  const rate = known ?? SONNET_FALLBACK_RATE;
  return {
    modelLabel: resolvedId,
    inputPerMTok: overrideInput ?? rate.input,
    outputPerMTok: overrideOutput ?? rate.output,
    approximated: (overrideInput === undefined && overrideOutput === undefined) && known === undefined,
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function formatUsd(amount: number): string {
  if (amount === 0) return "$0.00";
  return amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

// ---------------------------------------------------------------------------
// Prompt units — one per (file, candidate-slice) sent to adjudication.
//
// A "wave" is one batchCandidates() group. A file whose own candidate count
// exceeds --max-candidates-per-batch is split across multiple dedicated
// waves, each carrying a different slice of that file's candidates — see
// batchCandidates' doc comment in ../src/adjudication.ts. Each (wave, file)
// pair gets exactly one buildAdjudicationPrompt() call and becomes exactly
// one adjudicateBatch() request (one pi session).
// ---------------------------------------------------------------------------

interface PromptUnit {
  filePath: string;
  candidates: Candidate[];
  prompt: string;
  promptChars: number;
  estimatedPromptTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  /** sha256(system + NUL + prompt) — both the replay lookup key and the --record fixture filename. */
  fixtureKey: string;
}

interface PromptWave {
  index: number;
  units: PromptUnit[];
  candidateCount: number;
  estimatedCostUsd: number;
}

function computeFixtureKey(params: { system: string; prompt: string }): string {
  return new Bun.CryptoHasher("sha256").update(params.system).update(" ").update(params.prompt).digest("hex");
}

function makePromptUnit(params: { filePath: string; candidates: Candidate[]; prompt: string; pricing: PricingInfo }): PromptUnit {
  const { filePath, candidates, prompt, pricing } = params;
  const estimatedPromptTokens = estimateTokens(ADJUDICATION_SYSTEM_PROMPT) + estimateTokens(prompt);
  const estimatedOutputTokens = candidates.length * ESTIMATED_OUTPUT_TOKENS_PER_FINDING;
  const estimatedCostUsd =
    (estimatedPromptTokens / 1_000_000) * pricing.inputPerMTok + (estimatedOutputTokens / 1_000_000) * pricing.outputPerMTok;
  return {
    filePath,
    candidates,
    prompt,
    promptChars: prompt.length,
    estimatedPromptTokens,
    estimatedOutputTokens,
    estimatedCostUsd,
    fixtureKey: computeFixtureKey({ system: ADJUDICATION_SYSTEM_PROMPT, prompt }),
  };
}

async function loadFileContent(params: { root: string; filePath: string; cache: Map<string, string>; errors: string[] }): Promise<string | null> {
  const { root, filePath, cache, errors } = params;
  const cached = cache.get(filePath);
  if (cached !== undefined) return cached;
  try {
    const content = await Bun.file(join(root, filePath)).text();
    cache.set(filePath, content);
    return content;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`${filePath}: could not read file content for prompt construction — ${message}`);
    return null;
  }
}

async function buildPromptWaves(params: {
  waves: Array<Array<{ filePath: string; candidates: Candidate[] }>>;
  project: ProjectConfig;
  pricing: PricingInfo;
  errors: string[];
}): Promise<PromptWave[]> {
  const { waves, project, pricing, errors } = params;
  const contentCache = new Map<string, string>();
  const promptWaves: PromptWave[] = [];

  for (const [index, wave] of waves.entries()) {
    const units: PromptUnit[] = [];
    for (const fileEntry of wave) {
      const content = await loadFileContent({ root: project.root, filePath: fileEntry.filePath, cache: contentCache, errors });
      if (content === null) continue;
      const prompt = buildAdjudicationPrompt({
        filePath: fileEntry.filePath,
        fileContent: content,
        candidates: fileEntry.candidates,
        info: project.info,
      });
      units.push(makePromptUnit({ filePath: fileEntry.filePath, candidates: fileEntry.candidates, prompt, pricing }));
    }
    promptWaves.push({
      index,
      units,
      candidateCount: units.reduce((sum, u) => sum + u.candidates.length, 0),
      estimatedCostUsd: units.reduce((sum, u) => sum + u.estimatedCostUsd, 0),
    });
  }
  return promptWaves;
}

// ---------------------------------------------------------------------------
// Fixtures (replay + --record)
// ---------------------------------------------------------------------------

interface FixtureFile {
  filePath: string;
  prompt: string;
  raw: string;
}

function isFixtureFile(value: unknown): value is FixtureFile {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.filePath === "string" && typeof record.prompt === "string" && typeof record.raw === "string";
}

async function readFixture(path: string): Promise<FixtureFile | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    const parsed: unknown = await file.json();
    return isFixtureFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeFixture(params: { path: string; filePath: string; prompt: string; raw: string }): Promise<void> {
  const { path, filePath, prompt, raw } = params;
  const payload: FixtureFile = { filePath, prompt, raw };
  await Bun.write(path, `${JSON.stringify(payload, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Adjudication run (mode dispatch)
// ---------------------------------------------------------------------------

interface AdjudicationRunResult {
  findings: Finding[];
  errors: string[];
  missingFixtures: string[];
  recordedFixtures: string[];
  wavesCompleted: number;
  wavesTotal: number;
  stoppedEarly?: { reason: string };
}

function emptyAdjudicationResult(wavesTotal: number, baseErrors: string[]): AdjudicationRunResult {
  return { findings: [], errors: [...baseErrors], missingFixtures: [], recordedFixtures: [], wavesCompleted: 0, wavesTotal };
}

async function runReplayMode(params: { promptWaves: PromptWave[]; fixturesDir: string; baseErrors: string[] }): Promise<AdjudicationRunResult> {
  const { promptWaves, fixturesDir, baseErrors } = params;
  const findings: Finding[] = [];
  const errors: string[] = [...baseErrors];
  const missingFixtures: string[] = [];

  for (const wave of promptWaves) {
    for (const unit of wave.units) {
      const fixturePath = join(fixturesDir, `${unit.fixtureKey}.json`);
      const fixture = await readFixture(fixturePath);
      if (fixture === null) {
        missingFixtures.push(`${unit.filePath} (key ${unit.fixtureKey}.json)`);
        continue;
      }
      const parsed = parseAdjudicationResponse({ raw: fixture.raw, filePath: unit.filePath, candidates: unit.candidates });
      findings.push(...parsed.findings);
      errors.push(...parsed.errors);
    }
  }

  return { findings, errors, missingFixtures, recordedFixtures: [], wavesCompleted: promptWaves.length, wavesTotal: promptWaves.length };
}

type LiveModeOutcome = { ok: true; result: AdjudicationRunResult } | { ok: false; reason: string };

async function runLiveMode(params: {
  promptWaves: PromptWave[];
  args: CliArgs;
  totalEstimatedCostUsd: number;
  totalCandidates: number;
  baseErrors: string[];
}): Promise<LiveModeOutcome> {
  const { promptWaves, args, totalEstimatedCostUsd, totalCandidates, baseErrors } = params;

  console.log("\nLive adjudication pre-flight");
  console.log(`  Candidates to adjudicate: ${totalCandidates}`);
  console.log(`  Prompt waves: ${promptWaves.length}`);
  console.log(`  Estimated cost: ${formatUsd(totalEstimatedCostUsd)} (heuristic estimate — see bench/E2E.md)`);

  if (!args.yesSpend) {
    return { ok: false, reason: "refusing to run: --mode live requires --yes-spend (this call may spend real money)" };
  }

  const keyValue = process.env[args.apiKeyEnv];
  if (keyValue === undefined || keyValue.trim().length === 0) {
    // Presence check only — the value itself is never read, logged, or echoed here or anywhere else in this script.
    return { ok: false, reason: `refusing to run: credential env var ${args.apiKeyEnv} is not set` };
  }

  if (args.maxCostUsd !== undefined && totalEstimatedCostUsd > args.maxCostUsd) {
    return {
      ok: false,
      reason: `refusing to run: estimated cost ${formatUsd(totalEstimatedCostUsd)} exceeds --max-cost-usd ${formatUsd(args.maxCostUsd)} before any batch has run — raise the cap or use --limit-files to shrink scope`,
    };
  }

  const options: SecondpassSandboxOptions = {
    workspaceId: args.workspaceId,
    apiKeyEnv: args.apiKeyEnv,
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  };

  const findings: Finding[] = [];
  const errors: string[] = [...baseErrors];
  const recordedFixtures: string[] = [];
  let runningCostUsd = 0;
  let wavesCompleted = 0;

  for (const wave of promptWaves) {
    if (wave.units.length === 0) {
      wavesCompleted += 1;
      continue;
    }

    if (args.maxCostUsd !== undefined && runningCostUsd + wave.estimatedCostUsd > args.maxCostUsd) {
      return {
        ok: true,
        result: {
          findings,
          errors,
          missingFixtures: [],
          recordedFixtures,
          wavesCompleted,
          wavesTotal: promptWaves.length,
          stoppedEarly: {
            reason: `stopped before wave ${wave.index + 1}/${promptWaves.length}: running cost ${formatUsd(runningCostUsd)} + this wave's estimate ${formatUsd(wave.estimatedCostUsd)} would exceed --max-cost-usd ${formatUsd(args.maxCostUsd)}`,
          },
        },
      };
    }

    console.log(
      `  Wave ${wave.index + 1}/${promptWaves.length}: ${wave.units.length} file(s), ${wave.candidateCount} candidate(s), est. ${formatUsd(wave.estimatedCostUsd)}`,
    );

    const outcomes = await adjudicateBatch({
      batches: wave.units.map((u) => ({ filePath: u.filePath, prompt: u.prompt })),
      system: ADJUDICATION_SYSTEM_PROMPT,
      options,
      ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
      onProgress: (p) =>
        console.error(
          `  [${p.settled}/${p.total}] ${p.ok ? "ok" : "FAILED"} ${p.filePath} (${(p.elapsedMs / 1000).toFixed(1)}s)`,
        ),
    });

    for (const outcome of outcomes) {
      const unit = wave.units.find((u) => u.filePath === outcome.filePath);
      if (outcome.raw === null) {
        errors.push(`${outcome.filePath}: adjudication call failed — ${outcome.error ?? "unknown error"}`);
        continue;
      }
      if (!unit) continue;
      const parsed = parseAdjudicationResponse({ raw: outcome.raw, filePath: outcome.filePath, candidates: unit.candidates });
      findings.push(...parsed.findings);
      errors.push(...parsed.errors);
      if (args.record) {
        const fixturePath = join(args.fixturesDir, `${unit.fixtureKey}.json`);
        await writeFixture({ path: fixturePath, filePath: unit.filePath, prompt: unit.prompt, raw: outcome.raw });
        recordedFixtures.push(fixturePath);
      }
    }

    runningCostUsd += wave.estimatedCostUsd;
    wavesCompleted += 1;
  }

  return { ok: true, result: { findings, errors, missingFixtures: [], recordedFixtures, wavesCompleted, wavesTotal: promptWaves.length } };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface FamilyStats {
  vulnSlug: string;
  noiseTier: NoiseTier;
  candidates: number;
  findings: number;
  confirmed: number;
  falsePositive: number;
  needsContext: number;
  precisionProxy: number | null;
}

interface FindingsByVerdict {
  confirmed: number;
  "false-positive": number;
  "needs-context": number;
}

interface FindingsBySeverity {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

interface StageTimings {
  scanMs: number;
  batchMs: number;
  buildPromptsMs: number;
  adjudicateMs: number;
  totalMs: number;
}

interface E2EReport {
  mode: Mode;
  project: { id: string; root: string };
  generatedAt: string;
  filesScanned: number;
  filesWithCandidates: number;
  filesConsidered: number;
  candidatesFound: number;
  candidatesByFamily: FamilyStats[];
  zeroConfirmedFamilies: string[];
  promptCount: number;
  promptWaveCount: number;
  promptSizeSummary: { totalChars: number; meanChars: number; maxChars: number; totalEstimatedPromptTokens: number; totalEstimatedOutputTokens: number };
  largestPrompts: Array<{ filePath: string; candidateCount: number; promptChars: number; estimatedPromptTokens: number }>;
  costEstimate: { modelLabel: string; approximated: boolean; pricePerMTokInput: number; pricePerMTokOutput: number; totalUsd: number };
  findingsByVerdict?: FindingsByVerdict;
  findingsBySeverity?: FindingsBySeverity;
  missingFixtures: string[];
  recordedFixtures: string[];
  stoppedEarly?: { reason: string };
  errors: string[];
  stageTimings: StageTimings;
}

function computeFamilyStats(params: { filesConsidered: ScannedFile[]; findings: Finding[]; mode: Mode }): FamilyStats[] {
  const { filesConsidered, findings, mode } = params;
  const bySlug = new Map<string, FamilyStats>();

  for (const file of filesConsidered) {
    for (const candidate of file.candidates) {
      const existing = bySlug.get(candidate.vulnSlug);
      if (existing) {
        existing.candidates += 1;
      } else {
        bySlug.set(candidate.vulnSlug, {
          vulnSlug: candidate.vulnSlug,
          noiseTier: candidate.noiseTier,
          candidates: 1,
          findings: 0,
          confirmed: 0,
          falsePositive: 0,
          needsContext: 0,
          precisionProxy: null,
        });
      }
    }
  }

  if (mode !== "dry") {
    for (const finding of findings) {
      const stat = bySlug.get(finding.vulnSlug);
      if (!stat) continue; // parseAdjudicationResponse only allows vulnSlugs that matched a sent candidate
      stat.findings += 1;
      if (finding.verdict === "confirmed") stat.confirmed += 1;
      else if (finding.verdict === "false-positive") stat.falsePositive += 1;
      else stat.needsContext += 1;
    }
    for (const stat of bySlug.values()) {
      stat.precisionProxy = stat.findings > 0 ? stat.confirmed / stat.findings : null;
    }
  }

  return Array.from(bySlug.values()).sort((a, b) => b.candidates - a.candidates || a.vulnSlug.localeCompare(b.vulnSlug));
}

function computeZeroConfirmedFamilies(stats: FamilyStats[]): string[] {
  return stats
    .filter((s) => s.findings >= LARGE_SAMPLE_THRESHOLD && s.confirmed === 0)
    .map((s) => `${s.vulnSlug} — 0/${s.findings} confirmed over a large sample; consider deleting or retuning this matcher`);
}

function computeFindingsByVerdict(findings: Finding[]): FindingsByVerdict {
  const result: FindingsByVerdict = { confirmed: 0, "false-positive": 0, "needs-context": 0 };
  for (const finding of findings) result[finding.verdict] += 1;
  return result;
}

function computeFindingsBySeverity(findings: Finding[]): FindingsBySeverity {
  const result: FindingsBySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) {
    if (finding.verdict === "confirmed") result[finding.severity] += 1;
  }
  return result;
}

function buildReport(params: {
  args: CliArgs;
  filesScanned: number;
  filesWithCandidates: number;
  filesConsidered: ScannedFile[];
  promptWaves: PromptWave[];
  pricing: PricingInfo;
  totalEstimatedCostUsd: number;
  adjudication: AdjudicationRunResult;
  timings: StageTimings;
}): E2EReport {
  const { args, filesScanned, filesWithCandidates, filesConsidered, promptWaves, pricing, totalEstimatedCostUsd, adjudication, timings } = params;

  const allUnits = promptWaves.flatMap((w) => w.units);
  const familyStats = computeFamilyStats({ filesConsidered, findings: adjudication.findings, mode: args.mode });

  const sortedByChars = [...allUnits].sort((a, b) => b.promptChars - a.promptChars).slice(0, TOP_PROMPTS_SHOWN);
  const totalChars = allUnits.reduce((sum, u) => sum + u.promptChars, 0);

  return {
    mode: args.mode,
    project: { id: args.projectId, root: args.projectRoot },
    generatedAt: new Date().toISOString(),
    filesScanned,
    filesWithCandidates,
    filesConsidered: filesConsidered.length,
    candidatesFound: filesConsidered.reduce((sum, f) => sum + f.candidates.length, 0),
    candidatesByFamily: familyStats,
    zeroConfirmedFamilies: args.mode === "dry" ? [] : computeZeroConfirmedFamilies(familyStats),
    promptCount: allUnits.length,
    promptWaveCount: promptWaves.length,
    promptSizeSummary: {
      totalChars,
      meanChars: allUnits.length > 0 ? Math.round(totalChars / allUnits.length) : 0,
      maxChars: allUnits.reduce((max, u) => Math.max(max, u.promptChars), 0),
      totalEstimatedPromptTokens: allUnits.reduce((sum, u) => sum + u.estimatedPromptTokens, 0),
      totalEstimatedOutputTokens: allUnits.reduce((sum, u) => sum + u.estimatedOutputTokens, 0),
    },
    largestPrompts: sortedByChars.map((u) => ({
      filePath: u.filePath,
      candidateCount: u.candidates.length,
      promptChars: u.promptChars,
      estimatedPromptTokens: u.estimatedPromptTokens,
    })),
    costEstimate: {
      modelLabel: pricing.modelLabel,
      approximated: pricing.approximated,
      pricePerMTokInput: pricing.inputPerMTok,
      pricePerMTokOutput: pricing.outputPerMTok,
      totalUsd: totalEstimatedCostUsd,
    },
    ...(args.mode !== "dry" ? { findingsByVerdict: computeFindingsByVerdict(adjudication.findings) } : {}),
    ...(args.mode !== "dry" ? { findingsBySeverity: computeFindingsBySeverity(adjudication.findings) } : {}),
    missingFixtures: adjudication.missingFixtures,
    recordedFixtures: adjudication.recordedFixtures,
    ...(adjudication.stoppedEarly ? { stoppedEarly: adjudication.stoppedEarly } : {}),
    errors: adjudication.errors,
    stageTimings: timings,
  };
}

function renderConsoleReport(report: E2EReport): string {
  const lines: string[] = [];
  lines.push(`\nsecondpass e2e report — mode: ${report.mode}`);
  lines.push(`  project: ${report.project.id} (${report.project.root})`);
  lines.push(`  generated: ${report.generatedAt}`);

  lines.push("\nScan");
  lines.push(`  files scanned: ${report.filesScanned}`);
  lines.push(`  files with candidates: ${report.filesWithCandidates}`);
  lines.push(`  files considered (post --limit-files): ${report.filesConsidered}`);
  lines.push(`  candidates found: ${report.candidatesFound}`);

  lines.push("\nCandidates by family");
  if (report.candidatesByFamily.length === 0) {
    lines.push("  (none)");
  } else {
    for (const stat of report.candidatesByFamily) {
      const precisionSuffix = report.mode === "dry" ? "" : ` | confirmed ${stat.confirmed}/${stat.findings} (${formatPercent(stat.precisionProxy)})`;
      lines.push(`  ${stat.vulnSlug.padEnd(28)} candidates=${stat.candidates} noiseTier=${stat.noiseTier}${precisionSuffix}`);
    }
  }
  if (report.zeroConfirmedFamilies.length > 0) {
    lines.push("\n  Zero-confirmed families (candidate for deletion/retune):");
    for (const line of report.zeroConfirmedFamilies) lines.push(`    - ${line}`);
  }

  lines.push("\nPrompts");
  lines.push(`  prompt waves: ${report.promptWaveCount}`);
  lines.push(`  prompts built: ${report.promptCount}`);
  lines.push(
    `  size: total ${report.promptSizeSummary.totalChars} chars, mean ${report.promptSizeSummary.meanChars} chars, max ${report.promptSizeSummary.maxChars} chars`,
  );
  lines.push(
    `  estimated tokens: ${report.promptSizeSummary.totalEstimatedPromptTokens} input + ${report.promptSizeSummary.totalEstimatedOutputTokens} output (heuristic, ~${CHARS_PER_TOKEN_ESTIMATE} chars/token)`,
  );
  if (report.largestPrompts.length > 0) {
    lines.push("  largest prompts:");
    for (const p of report.largestPrompts) {
      lines.push(`    - ${p.filePath} (${p.candidateCount} candidate(s), ${p.promptChars} chars, ~${p.estimatedPromptTokens} tokens)`);
    }
  }

  lines.push("\nEstimated cost");
  const approxNote = report.costEstimate.approximated ? " (approximated — model not in the cached rate card)" : "";
  lines.push(`  model: ${report.costEstimate.modelLabel}${approxNote}`);
  lines.push(`  rate: $${report.costEstimate.pricePerMTokInput}/MTok in, $${report.costEstimate.pricePerMTokOutput}/MTok out`);
  lines.push(`  estimated total: ${formatUsd(report.costEstimate.totalUsd)}`);

  if (report.findingsByVerdict) {
    lines.push("\nFindings by verdict");
    lines.push(
      `  confirmed=${report.findingsByVerdict.confirmed} false-positive=${report.findingsByVerdict["false-positive"]} needs-context=${report.findingsByVerdict["needs-context"]}`,
    );
  }
  if (report.findingsBySeverity) {
    lines.push("\nFindings by severity (confirmed only)");
    lines.push(
      `  critical=${report.findingsBySeverity.critical} high=${report.findingsBySeverity.high} medium=${report.findingsBySeverity.medium} low=${report.findingsBySeverity.low}`,
    );
  }

  if (report.missingFixtures.length > 0) {
    lines.push(`\nMissing fixtures (${report.missingFixtures.length}) — replay served no response for these prompts:`);
    for (const m of report.missingFixtures) lines.push(`  - ${m}`);
  }
  if (report.recordedFixtures.length > 0) {
    lines.push(`\nRecorded ${report.recordedFixtures.length} fixture(s):`);
    for (const f of report.recordedFixtures) lines.push(`  - ${f}`);
  }
  if (report.stoppedEarly) {
    lines.push(`\nStopped early: ${report.stoppedEarly.reason}`);
  }
  if (report.errors.length > 0) {
    lines.push(`\nErrors (${report.errors.length}):`);
    for (const e of report.errors) lines.push(`  - ${e}`);
  }

  lines.push("\nStage timings (ms)");
  lines.push(
    `  scan=${report.stageTimings.scanMs.toFixed(0)} batch=${report.stageTimings.batchMs.toFixed(0)} buildPrompts=${report.stageTimings.buildPromptsMs.toFixed(0)} adjudicate=${report.stageTimings.adjudicateMs.toFixed(0)} total=${report.stageTimings.totalMs.toFixed(0)}`,
  );

  return lines.join("\n");
}

function renderMarkdownReport(report: E2EReport): string {
  const lines: string[] = [];
  lines.push(`# secondpass e2e report`);
  lines.push("");
  lines.push(`- **Mode:** ${report.mode}`);
  lines.push(`- **Project:** ${report.project.id} (\`${report.project.root}\`)`);
  lines.push(`- **Generated:** ${report.generatedAt}`);
  lines.push("");

  lines.push("## Scan");
  lines.push("");
  lines.push(`| Files scanned | Files with candidates | Files considered | Candidates found |`);
  lines.push(`| --- | --- | --- | --- |`);
  lines.push(`| ${report.filesScanned} | ${report.filesWithCandidates} | ${report.filesConsidered} | ${report.candidatesFound} |`);
  lines.push("");

  lines.push("## Candidates by family");
  lines.push("");
  if (report.mode === "dry") {
    lines.push(`| Family | Candidates | Noise tier |`);
    lines.push(`| --- | --- | --- |`);
    for (const stat of report.candidatesByFamily) {
      lines.push(`| ${stat.vulnSlug} | ${stat.candidates} | ${stat.noiseTier} |`);
    }
  } else {
    lines.push(`| Family | Candidates | Noise tier | Confirmed | False positive | Needs context | Precision proxy |`);
    lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);
    for (const stat of report.candidatesByFamily) {
      lines.push(
        `| ${stat.vulnSlug} | ${stat.candidates} | ${stat.noiseTier} | ${stat.confirmed} | ${stat.falsePositive} | ${stat.needsContext} | ${formatPercent(stat.precisionProxy)} |`,
      );
    }
  }
  lines.push("");
  if (report.zeroConfirmedFamilies.length > 0) {
    lines.push("**Zero-confirmed families (candidate for deletion/retune):**");
    lines.push("");
    for (const line of report.zeroConfirmedFamilies) lines.push(`- ${line}`);
    lines.push("");
  }

  lines.push("## Prompts & estimated cost");
  lines.push("");
  lines.push(`- Prompt waves: ${report.promptWaveCount}; prompts built: ${report.promptCount}`);
  lines.push(
    `- Size: total ${report.promptSizeSummary.totalChars} chars, mean ${report.promptSizeSummary.meanChars} chars, max ${report.promptSizeSummary.maxChars} chars`,
  );
  lines.push(
    `- Estimated tokens: ${report.promptSizeSummary.totalEstimatedPromptTokens} input + ${report.promptSizeSummary.totalEstimatedOutputTokens} output (~${CHARS_PER_TOKEN_ESTIMATE} chars/token heuristic)`,
  );
  const approxNote = report.costEstimate.approximated ? " (approximated — model not in the cached rate card)" : "";
  lines.push(
    `- Model: ${report.costEstimate.modelLabel}${approxNote} — $${report.costEstimate.pricePerMTokInput}/MTok in, $${report.costEstimate.pricePerMTokOutput}/MTok out`,
  );
  lines.push(`- **Estimated total cost: ${formatUsd(report.costEstimate.totalUsd)}**`);
  lines.push("");
  if (report.largestPrompts.length > 0) {
    lines.push("**Largest prompts:**");
    lines.push("");
    for (const p of report.largestPrompts) {
      lines.push(`- \`${p.filePath}\` — ${p.candidateCount} candidate(s), ${p.promptChars} chars, ~${p.estimatedPromptTokens} tokens`);
    }
    lines.push("");
  }

  if (report.findingsByVerdict) {
    lines.push("## Findings by verdict");
    lines.push("");
    lines.push(`| Confirmed | False positive | Needs context |`);
    lines.push(`| --- | --- | --- |`);
    lines.push(`| ${report.findingsByVerdict.confirmed} | ${report.findingsByVerdict["false-positive"]} | ${report.findingsByVerdict["needs-context"]} |`);
    lines.push("");
  }
  if (report.findingsBySeverity) {
    lines.push("## Findings by severity (confirmed only)");
    lines.push("");
    lines.push(`| Critical | High | Medium | Low |`);
    lines.push(`| --- | --- | --- | --- |`);
    lines.push(
      `| ${report.findingsBySeverity.critical} | ${report.findingsBySeverity.high} | ${report.findingsBySeverity.medium} | ${report.findingsBySeverity.low} |`,
    );
    lines.push("");
  }

  if (report.missingFixtures.length > 0) {
    lines.push(`## Missing fixtures (${report.missingFixtures.length})`);
    lines.push("");
    for (const m of report.missingFixtures) lines.push(`- ${m}`);
    lines.push("");
  }
  if (report.recordedFixtures.length > 0) {
    lines.push(`## Recorded fixtures (${report.recordedFixtures.length})`);
    lines.push("");
    for (const f of report.recordedFixtures) lines.push(`- \`${f}\``);
    lines.push("");
  }
  if (report.stoppedEarly) {
    lines.push(`## Stopped early`);
    lines.push("");
    lines.push(report.stoppedEarly.reason);
    lines.push("");
  }
  if (report.errors.length > 0) {
    lines.push(`## Errors (${report.errors.length})`);
    lines.push("");
    for (const e of report.errors) lines.push(`- ${e}`);
    lines.push("");
  }

  lines.push("## Stage timings");
  lines.push("");
  lines.push(`| Scan | Batch | Build prompts | Adjudicate | Total |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  lines.push(
    `| ${report.stageTimings.scanMs.toFixed(0)}ms | ${report.stageTimings.batchMs.toFixed(0)}ms | ${report.stageTimings.buildPromptsMs.toFixed(0)}ms | ${report.stageTimings.adjudicateMs.toFixed(0)}ms | ${report.stageTimings.totalMs.toFixed(0)}ms |`,
  );
  lines.push("");

  return lines.join("\n");
}

async function emitReport(params: { report: E2EReport; args: CliArgs }): Promise<void> {
  const { report, args } = params;
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderConsoleReport(report));
  }
  if (args.out) {
    await Bun.write(args.out, renderMarkdownReport(report));
    if (!args.json) console.log(`\nMarkdown report written to ${args.out}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!existsSync(args.projectRoot)) {
    throw new UsageError(`--project path does not exist: ${args.projectRoot}`);
  }

  let info: string | undefined;
  if (args.info !== undefined) {
    if (!existsSync(args.info)) {
      throw new UsageError(`--info path does not exist: ${args.info}`);
    }
    info = await Bun.file(args.info).text();
  }

  const matchers = ALL_MATCHERS;
  const overallStart = performance.now();

  const scanStart = performance.now();
  const project: ProjectConfig = { id: args.projectId, root: args.projectRoot, info };
  const scanResult = await scanProject({ project, matchers, runId: randomUUID() });
  const scanMs = performance.now() - scanStart;

  const filesWithCandidates = scanResult.files;
  const filesConsidered = args.limitFiles !== undefined ? filesWithCandidates.slice(0, args.limitFiles) : filesWithCandidates;

  const batchStart = performance.now();
  const waves = batchCandidates({
    files: filesConsidered.map((f) => ({ filePath: f.filePath, candidates: f.candidates })),
    maxCandidatesPerBatch: args.maxCandidatesPerBatch,
  });
  const batchMs = performance.now() - batchStart;

  const pricing = resolvePricing({ modelId: args.model, overrideInput: args.priceInput, overrideOutput: args.priceOutput });

  const buildStart = performance.now();
  const buildErrors: string[] = [];
  const promptWaves = await buildPromptWaves({ waves, project, pricing, errors: buildErrors });
  const buildPromptsMs = performance.now() - buildStart;

  const totalEstimatedCostUsd = promptWaves.reduce((sum, w) => sum + w.estimatedCostUsd, 0);
  const totalCandidates = promptWaves.reduce((sum, w) => sum + w.candidateCount, 0);

  const adjudicateStart = performance.now();
  let adjudication: AdjudicationRunResult;
  if (args.mode === "dry") {
    adjudication = emptyAdjudicationResult(promptWaves.length, buildErrors);
  } else if (args.mode === "replay") {
    adjudication = await runReplayMode({ promptWaves, fixturesDir: args.fixturesDir, baseErrors: buildErrors });
  } else {
    const outcome = await runLiveMode({ promptWaves, args, totalEstimatedCostUsd, totalCandidates, baseErrors: buildErrors });
    if (!outcome.ok) {
      console.error(`\nsecondpass bench/e2e.ts: ${outcome.reason}`);
      process.exitCode = 1;
      return;
    }
    adjudication = outcome.result;
  }
  const adjudicateMs = performance.now() - adjudicateStart;

  const totalMs = performance.now() - overallStart;

  const report = buildReport({
    args,
    filesScanned: scanResult.filesScanned,
    filesWithCandidates: filesWithCandidates.length,
    filesConsidered,
    promptWaves,
    pricing,
    totalEstimatedCostUsd,
    adjudication,
    timings: { scanMs, batchMs, buildPromptsMs, adjudicateMs, totalMs },
  });

  await emitReport({ report, args });

  if (args.mode === "replay" && report.missingFixtures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(`secondpass bench/e2e.ts: ${err.message}`);
    console.error("Run with --help for usage.");
  } else {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`secondpass bench/e2e.ts: unexpected error\n${message}`);
  }
  process.exitCode = 1;
});
