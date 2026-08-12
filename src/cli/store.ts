/**
 * Run persistence: `.secondpass/runs/<projectId>/<runId>.json`.
 *
 * Plain files, one per run, no database and no daemon. A run record is
 * meant to be diffable in review, greppable from a terminal, and readable
 * by a human a month later without secondpass installed — so it stores the
 * findings and the scan tally verbatim rather than an index into something
 * else.
 *
 * There is no server-side counterpart and no sync. If a team wants shared
 * history, these files are the artifact to publish — which is why the run id
 * is sortable and the record is self-contained.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Finding } from "../types.js";
import type { RunScanResult } from "../pipeline.js";
import { stateDir } from "./config.js";

export interface StoredRun extends RunScanResult {
  /** Schema version of this record, so an old file can be rejected loudly. */
  version: 1;
  /** How the run was invoked, for reproducibility. Never contains a credential value. */
  invocation: {
    command: string;
    apiKeyEnv: string | null;
    model: string | null;
    matcherPacks: string[];
    adjudicated: boolean;
  };
}

export const RUN_RECORD_VERSION = 1;

/**
 * Sortable, collision-resistant, and readable at a glance.
 * `20260812T041530-a1b2c3d4` — the timestamp orders runs lexically, the
 * suffix keeps two runs started in the same second apart.
 */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("Z", "");
  const suffix = Math.abs(
    Number.parseInt(new Bun.CryptoHasher("sha256").update(`${now.getTime()}:${process.pid}`).digest("hex").slice(0, 8), 16),
  )
    .toString(16)
    .padStart(8, "0")
    .slice(0, 8);
  return `${stamp}-${suffix}`;
}

function runsDir(params: { baseDir: string; projectId: string }): string {
  return join(stateDir(params.baseDir), "runs", params.projectId);
}

export function saveRun(params: { baseDir: string; run: StoredRun }): string {
  const dir = runsDir({ baseDir: params.baseDir, projectId: params.run.projectId });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${params.run.runId}.json`);
  writeFileSync(path, `${JSON.stringify(params.run, null, 2)}\n`, "utf8");
  return path;
}

export interface RunSummary {
  runId: string;
  projectId: string;
  startedAt: string;
  adjudicated: boolean;
  filesScanned: number;
  candidatesFound: number;
  confirmed: number;
  needsContext: number;
  falsePositive: number;
  errors: number;
  path: string;
}

export function summarize(run: StoredRun, path: string): RunSummary {
  const byVerdict = countVerdicts(run.findings);
  return {
    runId: run.runId,
    projectId: run.projectId,
    startedAt: run.startedAt,
    adjudicated: run.adjudicated,
    filesScanned: run.scan.filesScanned,
    candidatesFound: run.scan.candidatesFound,
    confirmed: byVerdict.confirmed,
    needsContext: byVerdict["needs-context"],
    falsePositive: byVerdict["false-positive"],
    errors: run.errors.length,
    path,
  };
}

export function countVerdicts(findings: readonly Finding[]): Record<Finding["verdict"], number> {
  const counts: Record<Finding["verdict"], number> = {
    confirmed: 0,
    "needs-context": 0,
    "false-positive": 0,
  };
  for (const f of findings) counts[f.verdict] += 1;
  return counts;
}

/** Every stored run across every project, newest first. */
export function listRuns(params: { baseDir: string; projectId?: string }): RunSummary[] {
  const root = join(stateDir(params.baseDir), "runs");
  if (!existsSync(root)) return [];
  const projectIds = params.projectId
    ? [params.projectId]
    : readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

  const out: RunSummary[] = [];
  for (const projectId of projectIds) {
    const dir = join(root, projectId);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      const run = readRunFile(path);
      if (run !== null) out.push(summarize(run, path));
    }
  }
  return out.sort((a, b) => b.runId.localeCompare(a.runId));
}

function readRunFile(path: string): StoredRun | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StoredRun;
    if (parsed.version !== RUN_RECORD_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Load a run by id, or the newest one when `runId` is omitted.
 * A partial id prefix is accepted — run ids are long and typing one in full
 * is a chore nobody should have to do.
 */
export function loadRun(params: {
  baseDir: string;
  runId?: string;
  projectId?: string;
}): { ok: true; run: StoredRun; path: string } | { ok: false; error: string } {
  const summaries = listRuns({
    baseDir: params.baseDir,
    ...(params.projectId === undefined ? {} : { projectId: params.projectId }),
  });
  if (summaries.length === 0) {
    return { ok: false, error: "no runs stored yet — run `secondpass scan` first" };
  }

  let chosen = summaries[0] as RunSummary;
  if (params.runId) {
    const matches = summaries.filter((s) => s.runId.startsWith(params.runId as string));
    if (matches.length === 0) return { ok: false, error: `no run matches "${params.runId}"` };
    if (matches.length > 1) {
      return {
        ok: false,
        error: `"${params.runId}" matches ${matches.length} runs: ${matches.map((m) => m.runId).join(", ")}`,
      };
    }
    chosen = matches[0] as RunSummary;
  }

  const run = readRunFile(chosen.path);
  if (run === null) return { ok: false, error: `${chosen.path} is not a readable secondpass run record` };
  return { ok: true, run, path: chosen.path };
}
