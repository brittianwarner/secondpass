/**
 * The whole scanner, as one call.
 *
 * `scan -> batch -> build prompts -> adjudicate -> findings`. Every step
 * already exists as a separate export; this is the composition, in one
 * place, so the CLI and any host that embeds secondpass run the *same*
 * pipeline rather than two drifting copies of it.
 *
 * It is deliberately not in the package barrel. Adjudication pulls in the
 * optional agentOS dependency, and the barrel promises you can import the
 * scan stage without it. Import this module explicitly:
 *
 *   import { runScan } from "secondpass/pipeline";
 *
 * The costed stage is opt-in per call (`adjudicate: false` stops after the
 * free pass), and nothing here reads a credential — the credential env var
 * NAME travels in `sandbox.apiKeyEnv` and the value is resolved once,
 * inside the sandbox module, into one VM session.
 */

import {
  ADJUDICATION_SYSTEM_PROMPT,
  batchCandidates,
  buildAdjudicationPrompt,
  parseAdjudicationResponse,
} from "./adjudication.js";
import { ALL_MATCHERS } from "./matchers/index.js";
import { scanProject } from "./scanner.js";
import type { Candidate, Finding, Matcher, ProjectConfig, ScanResult } from "./types.js";

/** Candidates per adjudication prompt. Above this a file is split across prompts. */
const DEFAULT_MAX_CANDIDATES_PER_BATCH = 20;

/**
 * Two adjudications in flight, by measurement.
 *
 * Concurrency here is a sidecar-process count, not a thread count — see
 * `adjudicateBatch`. Measured with `bench/pool-sweep.ts`: 1 worker 16.3s,
 * 2 workers 8.5s (1.91x), 4 workers 6.0s (2.71x). Two is where the return
 * is still essentially linear.
 */
const DEFAULT_CONCURRENCY = 2;

export interface RunSandboxOptions {
  /** Env var NAME holding the model credential. The value is never read here. */
  apiKeyEnv?: string;
  /** Model id passed through to the sandbox. Omit for the provider default. */
  model?: string;
  /** Per-adjudication timeout. */
  timeoutMs?: number;
  /** Sandbox workspace scope. Defaults to the run id. */
  workspaceId?: string;
  /** See {@link DEFAULT_CONCURRENCY} before raising this. */
  concurrency?: number;
}

export type RunEvent =
  | { kind: "scan-started"; root: string }
  | { kind: "scan-complete"; filesScanned: number; filesWithCandidates: number; candidatesFound: number; durationMs: number }
  | { kind: "adjudication-skipped"; reason: string }
  | { kind: "adjudication-started"; prompts: number; candidates: number }
  | { kind: "adjudication-progress"; settled: number; total: number; filePath: string; ok: boolean; elapsedMs: number }
  | { kind: "adjudication-complete"; findings: number; durationMs: number };

export interface RunScanParams {
  project: ProjectConfig;
  runId: string;
  matchers?: readonly Matcher[];
  /** When false, stop after the free deterministic pass. */
  adjudicate: boolean;
  maxCandidatesPerBatch?: number;
  sandbox?: RunSandboxOptions;
  onEvent?: (event: RunEvent) => void;
}

export interface RunScanResult {
  runId: string;
  projectId: string;
  rootPath: string;
  startedAt: string;
  completedAt: string;
  adjudicated: boolean;
  scan: {
    filesScanned: number;
    filesWithCandidates: number;
    candidatesFound: number;
    durationMs: number;
  };
  /** Every candidate the scan produced, by file. Kept so a report can show what was *considered*. */
  files: ScanResult["files"];
  findings: Finding[];
  /**
   * Anything that went wrong without ending the run: a failed model call, a
   * malformed response entry, an unreadable file. A run with errors is still
   * a run — but a report that hides them is a lie, so they are first-class.
   */
  errors: string[];
  durationMs: number;
}

/** Read the files a prompt needs, once, keyed by repo-relative path. */
async function loadContents(params: {
  root: string;
  filePaths: readonly string[];
  errors: string[];
}): Promise<Map<string, string>> {
  const { root, filePaths, errors } = params;
  const contents = new Map<string, string>();
  for (const filePath of filePaths) {
    if (contents.has(filePath)) continue;
    try {
      contents.set(filePath, await Bun.file(`${root}/${filePath}`).text());
    } catch (err) {
      errors.push(`could not re-read ${filePath} for adjudication: ${errorText(err)}`);
    }
  }
  return contents;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the scanner end to end.
 *
 * Never throws for an expected failure. A missing credential, a VM that
 * won't boot, a model that returns garbage — each lands in `errors` with
 * the findings that did survive, because a partial result the caller can
 * see beats an exception that discards the work already paid for.
 */
export async function runScan(params: RunScanParams): Promise<RunScanResult> {
  const { project, runId, adjudicate, onEvent } = params;
  const matchers = params.matchers ?? ALL_MATCHERS;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const errors: string[] = [];

  onEvent?.({ kind: "scan-started", root: project.root });
  const scan = await scanProject({ project, matchers, runId });

  onEvent?.({
    kind: "scan-complete",
    filesScanned: scan.filesScanned,
    filesWithCandidates: scan.files.length,
    candidatesFound: scan.candidatesFound,
    durationMs: scan.durationMs,
  });

  const base: Omit<RunScanResult, "completedAt" | "durationMs"> = {
    runId,
    projectId: project.id,
    rootPath: project.root,
    startedAt,
    adjudicated: false,
    scan: {
      filesScanned: scan.filesScanned,
      filesWithCandidates: scan.files.length,
      candidatesFound: scan.candidatesFound,
      durationMs: scan.durationMs,
    },
    files: scan.files,
    findings: [],
    errors,
  };

  const finish = (result: Omit<RunScanResult, "completedAt" | "durationMs">): RunScanResult => {
    const completedAtMs = Date.now();
    return {
      ...result,
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
    };
  };

  if (!adjudicate) {
    onEvent?.({ kind: "adjudication-skipped", reason: "adjudication not requested" });
    return finish(base);
  }
  if (scan.candidatesFound === 0) {
    onEvent?.({ kind: "adjudication-skipped", reason: "the scan found nothing to adjudicate" });
    return finish({ ...base, adjudicated: true });
  }

  // Import lazily: a scan-only run must not pay for — or fail on — the
  // optional agentOS dependency.
  const { adjudicateBatch } = await import("./sandbox/agentos-runner.js");

  const waves = batchCandidates({
    files: scan.files.map((f) => ({ filePath: f.filePath, candidates: f.candidates })),
    maxCandidatesPerBatch: params.maxCandidatesPerBatch ?? DEFAULT_MAX_CANDIDATES_PER_BATCH,
  });

  const contents = await loadContents({
    root: project.root,
    filePaths: waves.flat().map((unit) => unit.filePath),
    errors,
  });

  interface PromptUnit {
    filePath: string;
    prompt: string;
    candidates: Candidate[];
  }
  const units: PromptUnit[] = [];
  for (const wave of waves) {
    for (const unit of wave) {
      const fileContent = contents.get(unit.filePath);
      if (fileContent === undefined) continue; // already recorded in errors
      units.push({
        filePath: unit.filePath,
        candidates: unit.candidates,
        prompt: buildAdjudicationPrompt({
          filePath: unit.filePath,
          fileContent,
          candidates: unit.candidates,
          ...(project.info === undefined ? {} : { info: project.info }),
        }),
      });
    }
  }

  if (units.length === 0) {
    errors.push("no adjudication prompts could be built — every candidate file failed to re-read");
    return finish({ ...base, adjudicated: true });
  }

  onEvent?.({
    kind: "adjudication-started",
    prompts: units.length,
    candidates: units.reduce((sum, u) => sum + u.candidates.length, 0),
  });

  const adjudicationStartedMs = Date.now();
  const outcomes = await adjudicateBatch({
    batches: units.map((u) => ({ filePath: u.filePath, prompt: u.prompt })),
    system: ADJUDICATION_SYSTEM_PROMPT,
    options: {
      workspaceId: params.sandbox?.workspaceId ?? `secondpass-${runId}`,
      ...(params.sandbox?.apiKeyEnv === undefined ? {} : { apiKeyEnv: params.sandbox.apiKeyEnv }),
      ...(params.sandbox?.model === undefined ? {} : { model: params.sandbox.model }),
      ...(params.sandbox?.timeoutMs === undefined ? {} : { timeoutMs: params.sandbox.timeoutMs }),
    },
    concurrency: params.sandbox?.concurrency ?? DEFAULT_CONCURRENCY,
    onProgress: onEvent
      ? (p) =>
          onEvent({
            kind: "adjudication-progress",
            settled: p.settled,
            total: p.total,
            filePath: p.filePath,
            ok: p.ok,
            elapsedMs: p.elapsedMs,
          })
      : undefined,
  });

  const findings: Finding[] = [];
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i] as PromptUnit;
    const outcome = outcomes[i];
    if (!outcome || outcome.raw === null) {
      errors.push(`adjudication failed for ${unit.filePath}: ${outcome?.error ?? "no outcome returned"}`);
      continue;
    }
    const parsed = parseAdjudicationResponse({
      raw: outcome.raw,
      filePath: unit.filePath,
      candidates: unit.candidates,
    });
    findings.push(...parsed.findings);
    for (const err of parsed.errors) errors.push(`${unit.filePath}: ${err}`);
  }

  onEvent?.({
    kind: "adjudication-complete",
    findings: findings.length,
    durationMs: Date.now() - adjudicationStartedMs,
  });

  return finish({ ...base, adjudicated: true, findings, errors });
}
