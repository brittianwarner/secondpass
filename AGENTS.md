# secondpass

`secondpass` is a two-stage security scanner (free regex `scan` → costed model
`adjudicate`) and an Apache-2.0 derivative of Vercel's deepsec — see
[`NOTICE`](./NOTICE). **[`README.md`](./README.md) is the primary document.**
It covers what secondpass is, install/quickstart, writing a matcher pack, the
`INFO.md` convention, the adjudication runtime, and honest limitations. Read
it first. This file only adds what an agent editing this package's own source
needs that the README doesn't already say.

## Boundary

Pure logic. No database, no queue, no daemon, no server. The scan stage
additionally never touches the network or a model — see **Hard constraints**.
The one exception is `src/sandbox/agentos-runner.ts`, which owns the agentOS
VM transport for adjudication; it is reachable only via `secondpass/sandbox`,
never through the root barrel (`src/index.ts`), so importing a matcher never
resolves agentOS.

**agentOS is the only runtime dependency.** Nothing else belongs in
`dependencies`. A scanner people will actually install is one that carries a
scanner's worth of weight; if a change here wants a server, a client, or an
orchestration framework, it is a change that belongs in the caller, not in
this package. Resolution stays lazy (`await import(specifier)` behind a
`const`, never an inline literal) so a missing or broken agentOS is an error
message from one command, not an import-time crash of all of them.

## File layout

| Path | Contents |
| --- | --- |
| `src/types.ts` | The whole contract — `Matcher`, `Candidate`, `ScanResult`, `Finding`, `ProjectConfig`. Read the header comment first; it's the two-stage design in one place. |
| `src/matchers/builtin.ts` | Generic web-app matchers — any TS/JS service. |
| `src/matchers/multi-tenancy.ts` | Generic multi-tenancy matchers — any service multiplexing tenants through one code path. Ships in `ALL_MATCHERS`. |
| `src/matchers/index.ts` | Registry barrel: `ALL_MATCHERS`, `getMatcher`, `matchersForTier`, `composeMatchers`. Downstream code (including root `index.ts`) imports from here, never from an individual matcher file. |
| `src/scanner.ts` | `scanContent` (pure) / `scanProject` (I/O shell). The free stage. |
| `src/adjudication.ts` | `buildAdjudicationPrompt`, `parseAdjudicationResponse`, `batchCandidates`. Transport-agnostic — no model call here. |
| `src/sandbox/agentos-runner.ts` | The agentOS VM transport. Server-only entry point, not in the root barrel. |
| `src/cli/` | The `secondpass` binary — `scan`, `init`, `doctor`, `runs`, `show`. |
| `bench/` | Measurement, not shipped: `evaluate.ts` (scan precision/recall), `adjudicate-eval.ts` (both stages), `injection-eval.ts` (prompt-injection resistance), `perf.ts` (throughput + ReDoS), `e2e.ts` (whole pipeline). Each has a doc beside it. |

## Adding a matcher

Full shape and the recall-over-precision framing are in the README's
"Writing your own matcher pack." The one rule that's easy to forget mid-edit:
**add a matcher only after a confirmed true positive shows you the pattern —
never speculatively.** A pattern earns its place by having caught something
real first; that's the only way to know what it should actually match.
`builtin.ts` and `multi-tenancy.ts` stay generic on purpose: a family that
only means something inside one company's codebase is noise in everyone
else's, and belongs in a pack that consumer composes in themselves.

## Architecture notes for this package's consumers

There is no orchestration layer, by design (README → *Architecture*). A
consumer calls `runScan` and gets a result; anything durable is theirs. That
puts one obligation on return shapes: **keep them flat and serializable** —
no class instances, no circular references, no live handles. A caller will
persist a `Finding` into a row or a document without asking permission, and a
shape that only survives in memory turns that into a silent data loss.

## Hard constraints

1. **The scan stage must never touch the network or a model.** `scanProject`
   / `scanContent` are pure regex over local file content. If a "matcher"
   needs a network call or a model to decide anything, it isn't a matcher —
   it belongs in adjudication.
2. **agentOS is the only runtime dependency.** See **Boundary**.

## Verify

```bash
bun run check          # tsc --noEmit + bun test
bun bench/evaluate.ts  # scan-stage precision/recall against bench/corpus
```

## Entry points

Two, and the split is load-bearing: the root barrel (`secondpass`) carries
scan, adjudication contracts, and the matcher registry with no optional
dependency behind any of it; `secondpass/sandbox` carries the agentOS VM
transport. Re-exporting the sandbox from the root would make every consumer
of a matcher resolve agentOS.
