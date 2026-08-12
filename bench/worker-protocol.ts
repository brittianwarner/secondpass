/**
 * Message shapes exchanged between `bench/perf.ts` and the isolated worker
 * at `bench/redos-worker.ts`. Kept in one file so the two ends can't drift.
 *
 * Two job kinds:
 *   "pattern" — time one regex against one adversarial input (`.test`).
 *               Used by the ReDoS guard (perf.ts section 4).
 *   "scan"    — time a full `scanContent` pass (every matcher, every
 *               pattern) against one content string. Used by the scaling
 *               curve (perf.ts section 5).
 */

export interface PatternJob {
  kind: "pattern";
  source: string;
  flags: string;
  input: string;
}

export interface ScanJob {
  kind: "scan";
  content: string;
}

export type WorkerJob = PatternJob | ScanJob;

export interface PatternJobResult {
  kind: "pattern";
  elapsedMs: number;
}

export interface ScanJobResult {
  kind: "scan";
  elapsedMs: number;
  candidateCount: number;
}

export type WorkerJobResult = PatternJobResult | ScanJobResult;
