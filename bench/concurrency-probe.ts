/**
 * Where does adjudication concurrency actually go?
 *
 * `adjudicateBatch` boots ONE VM and runs each item on its own pi session.
 * Measured on real corpus work, raising `concurrency` bought no throughput
 * at all (24 adjudications: 621s at concurrency 1, 640s at concurrency 4)
 * while inflating per-item wall time roughly linearly with the setting.
 * That is the signature of a shared resource, not of parallel work.
 *
 * This probe isolates which resource, by holding the work constant and
 * varying only the VM topology:
 *
 *   A  one VM,  N sessions, concurrent   (what adjudicateBatch does today)
 *   B  N VMs,   one session each, concurrent
 *   C  one call, alone                   (the uncontended baseline)
 *
 * If A ≈ N × C and B ≈ C, the bottleneck is the VM, and the fix is more
 * VMs — not more sessions inside one. If A ≈ B ≈ N × C, the bottleneck is
 * the sidecar process or the host, and more VMs would not help either.
 *
 * The prompt is deliberately trivial so the measurement is dominated by
 * dispatch, not by how long a model thinks. It still costs real tokens —
 * a few hundred per call — so it demands --yes-spend like every other live
 * harness here.
 *
 *   bun bench/concurrency-probe.ts --yes-spend --n 4
 */

import { adjudicateBatch, adjudicateInSandbox } from "../src/sandbox/agentos-runner.js";

const SYSTEM = "You are a latency probe. Reply with exactly the word OK and nothing else.";
const PROMPT = "Reply with exactly: OK";

function parseArgs(argv: string[]): { yesSpend: boolean; n: number; apiKeyEnv?: string; model?: string } {
  const raw = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      raw.set(token.slice(2), next);
      i += 1;
    } else {
      raw.set(token.slice(2), true);
    }
  }
  const str = (k: string): string | undefined => {
    const v = raw.get(k);
    return typeof v === "string" ? v : undefined;
  };
  return {
    yesSpend: raw.has("yes-spend"),
    n: Number(str("n") ?? 4),
    ...(str("api-key-env") === undefined ? {} : { apiKeyEnv: str("api-key-env") as string }),
    ...(str("model") === undefined ? {} : { model: str("model") as string }),
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = Date.now();
  const value = await fn();
  return { ms: Date.now() - start, value };
}

const args = parseArgs(process.argv.slice(2));
if (!args.yesSpend) {
  console.error("refusing to run: this makes real model calls. Pass --yes-spend.");
  process.exit(2);
}

const options = {
  workspaceId: "secondpass-concurrency-probe",
  timeoutMs: 300_000,
  ...(args.apiKeyEnv === undefined ? {} : { apiKeyEnv: args.apiKeyEnv }),
  ...(args.model === undefined ? {} : { model: args.model }),
};

console.log(`secondpass concurrency probe — N=${args.n}\n`);

// C — one call, alone. Everything else is measured against this.
const baseline = await timed(() => adjudicateInSandbox({ prompt: PROMPT, system: SYSTEM, options }));
const baselineOk = baseline.value.ok;
console.log(`C  baseline (1 VM, 1 session, alone):        ${(baseline.ms / 1000).toFixed(1)}s  ${baselineOk ? "ok" : `FAILED: ${"error" in baseline.value ? baseline.value.error : ""}`}`);
if (!baselineOk) process.exit(1);

// A — one VM, N sessions, concurrent. Today's adjudicateBatch shape.
const perItemA: number[] = [];
const a = await timed(() =>
  adjudicateBatch({
    batches: Array.from({ length: args.n }, (_, i) => ({ filePath: `probe-${i}.ts`, prompt: PROMPT })),
    system: SYSTEM,
    options,
    concurrency: args.n,
    onProgress: (p) => perItemA.push(p.elapsedMs),
  }),
);
const aFailures = a.value.filter((o) => o.raw === null).length;
console.log(
  `A  one VM, ${args.n} sessions, concurrent:            ${(a.ms / 1000).toFixed(1)}s  ` +
    `(per-item ${perItemA.map((ms) => (ms / 1000).toFixed(1)).join(", ")}s)` +
    (aFailures > 0 ? `  ${aFailures} FAILED` : ""),
);

// B — N VMs, one session each, concurrent.
const b = await timed(() =>
  Promise.all(
    Array.from({ length: args.n }, (_, i) =>
      timed(() =>
        adjudicateInSandbox({
          prompt: PROMPT,
          system: SYSTEM,
          // A distinct workspace per VM: same isolation the batch path gives
          // each session, just hoisted up to the VM boundary.
          options: { ...options, workspaceId: `${options.workspaceId}-${i}` },
        }),
      ),
    ),
  ),
);
const perItemB = b.value.map((r) => r.ms);
const bFailures = b.value.filter((r) => !r.value.ok).length;
console.log(
  `B  ${args.n} VMs, 1 session each, concurrent:         ${(b.ms / 1000).toFixed(1)}s  ` +
    `(per-item ${perItemB.map((ms) => (ms / 1000).toFixed(1)).join(", ")}s)` +
    (bFailures > 0 ? `  ${bFailures} FAILED` : ""),
);

const ideal = baseline.ms;
const serial = baseline.ms * args.n;
console.log(
  `\nreference points: perfect parallelism ${(ideal / 1000).toFixed(1)}s · fully serial ${(serial / 1000).toFixed(1)}s`,
);
console.log(
  `speedup vs serial — A ${(serial / a.ms).toFixed(2)}x, B ${(serial / b.ms).toFixed(2)}x  (${args.n}.00x would be perfect)`,
);

const verdict =
  b.ms < a.ms * 0.75
    ? "VERDICT: the VM is the bottleneck. More sessions in one VM do not parallelize; more VMs do."
    : a.ms < b.ms * 0.75
      ? "VERDICT: VM boot dominates. Sessions in one VM are the cheaper axis."
      : "VERDICT: neither topology parallelizes — the bottleneck is below the VM (sidecar or host).";
console.log(`\n${verdict}`);
