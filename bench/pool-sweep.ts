/**
 * How many sidecar pools is the right number?
 *
 * `bench/concurrency-probe.ts` established that adjudication parallelism is
 * bounded by the agentOS *sidecar process*, not by sessions or VMs, and
 * `adjudicateBatch` now gives each worker its own pool (= its own sidecar).
 * That turns concurrency into a real resource decision: every worker costs
 * a process, so the question is where the speedup curve flattens.
 *
 * This sweeps the same fixed batch across worker counts and reports the
 * speedup and the marginal gain of each step, so the default is chosen from
 * a curve rather than from taste.
 *
 *   bun bench/pool-sweep.ts --yes-spend --items 8 --workers 1,2,4
 */

import { adjudicateBatch } from "../src/sandbox/agentos-runner.js";

const SYSTEM = "You are a latency probe. Reply with exactly the word OK and nothing else.";
const PROMPT = "Reply with exactly: OK";

function parseArgs(argv: string[]): {
  yesSpend: boolean;
  items: number;
  workers: number[];
  apiKeyEnv?: string;
  model?: string;
} {
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
    items: Number(str("items") ?? 8),
    workers: (str("workers") ?? "1,2,4").split(",").map((s) => Number(s.trim())).filter((n) => n > 0),
    ...(str("api-key-env") === undefined ? {} : { apiKeyEnv: str("api-key-env") as string }),
    ...(str("model") === undefined ? {} : { model: str("model") as string }),
  };
}

const args = parseArgs(process.argv.slice(2));
if (!args.yesSpend) {
  console.error("refusing to run: this makes real model calls. Pass --yes-spend.");
  process.exit(2);
}

const batches = Array.from({ length: args.items }, (_, i) => ({
  filePath: `probe-${i}.ts`,
  prompt: PROMPT,
}));

console.log(`secondpass sidecar-pool sweep — ${args.items} items per configuration\n`);
console.log("workers  wall     per-item avg  speedup  marginal");
console.log("-------  -------  ------------  -------  --------");

let previousWall: number | null = null;
let baselineWall: number | null = null;

for (const workers of args.workers) {
  const startedAt = Date.now();
  const outcomes = await adjudicateBatch({
    batches,
    system: SYSTEM,
    options: {
      workspaceId: `secondpass-pool-sweep-${workers}`,
      timeoutMs: 300_000,
      ...(args.apiKeyEnv === undefined ? {} : { apiKeyEnv: args.apiKeyEnv }),
      ...(args.model === undefined ? {} : { model: args.model }),
    },
    concurrency: workers,
  });
  const wall = Date.now() - startedAt;
  const failures = outcomes.filter((o) => o.raw === null).length;
  baselineWall ??= wall;

  const speedup = baselineWall / wall;
  const marginal = previousWall === null ? null : previousWall / wall;
  console.log(
    `${String(workers).padStart(7)}  ${`${(wall / 1000).toFixed(1)}s`.padStart(7)}  ` +
      `${`${(wall / args.items / 1000).toFixed(2)}s`.padStart(12)}  ` +
      `${`${speedup.toFixed(2)}x`.padStart(7)}  ` +
      `${marginal === null ? "     —" : `${marginal.toFixed(2)}x`.padStart(8)}` +
      (failures > 0 ? `   ${failures} FAILED` : ""),
  );
  previousWall = wall;
}

console.log(
  "\nmarginal < ~1.2x means the next step is buying a sidecar process for almost nothing.",
);
