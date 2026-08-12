/**
 * Isolated execution worker for `bench/perf.ts`.
 *
 * A genuinely catastrophic regex can block its thread synchronously
 * forever. Running candidate regexes (and full `scanContent` passes) here,
 * off the main thread, lets `perf.ts` enforce a hard wall-clock kill
 * (`Worker.terminate()`) without wedging the benchmark process itself —
 * the exact failure mode the ReDoS guard exists to catch must never be able
 * to take the guard down with it.
 *
 * One job in, one result out (see `worker-protocol.ts`). The parent decides
 * whether to keep reusing this worker or discard it after a hard kill —
 * see `runIsolated` in `perf.ts`.
 */

import { scanContent } from "../src/scanner.js";
import { ALL_MATCHERS } from "../src/matchers/index.js";
import type {
  PatternJob,
  PatternJobResult,
  ScanJob,
  ScanJobResult,
  WorkerJob,
  WorkerJobResult,
} from "./worker-protocol.js";

// Imported once per worker instance, not per job — the same registry the
// scan stage runs by default, so the "scan" job timing reflects real cost.
const FULL_MATCHERS = ALL_MATCHERS;

function runPatternJob(job: PatternJob): PatternJobResult {
  const regex = new RegExp(job.source, job.flags);
  const start = Bun.nanoseconds();
  regex.test(job.input);
  const elapsedMs = (Bun.nanoseconds() - start) / 1_000_000;
  return { kind: "pattern", elapsedMs };
}

function runScanJob(job: ScanJob): ScanJobResult {
  const start = Bun.nanoseconds();
  const candidates = scanContent({
    filePath: "synthetic.ts",
    content: job.content,
    matchers: FULL_MATCHERS,
  });
  const elapsedMs = (Bun.nanoseconds() - start) / 1_000_000;
  return { kind: "scan", elapsedMs, candidateCount: candidates.length };
}

function runJob(job: WorkerJob): WorkerJobResult {
  return job.kind === "pattern" ? runPatternJob(job) : runScanJob(job);
}

declare const self: Worker;

self.onmessage = (event: MessageEvent<WorkerJob>): void => {
  postMessage(runJob(event.data));
};
