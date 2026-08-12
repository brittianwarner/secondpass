# secondpass end-to-end runner

`bench/e2e.ts` drives the whole pipeline against a real project: scan →
batch candidates → build prompts → adjudicate → parse findings → report.
It is a different tool from `bench/evaluate.ts` (precision/recall against
the labeled corpus in `bench/corpus/` — see `bench/README.md`) and
`bench/perf.ts` (throughput/ReDoS — see `bench/PERF.md`): those two answer
"is the scan stage accurate/fast"; this one answers "what does a real run
of the whole two-stage pipeline actually look like, end to end, including
the model-driven adjudication stage" — sizes, cost, and (in `replay`/`live`)
what the model actually said.

```bash
bun bench/e2e.ts                                          # dry mode, bench/fixtures/demo-project
bun bench/e2e.ts --mode dry --project ../my-app/src --json
bun bench/e2e.ts --mode replay --out bench/e2e-report.md
bun bench/e2e.ts --mode live --yes-spend --max-cost-usd 2.00 --limit-files 5 --record
bun bench/e2e.ts --help
```

Also wired as `bun run bench:e2e` (and folded into `bun run bench:all`,
which chains `evaluate.ts` → `perf.ts` → `e2e.ts` — `bench:all` therefore
runs `e2e.ts` in its default `dry` mode, never spending anything).

## The three modes

### `dry` (default)

Everything except the model call: scans the project, batches candidates,
builds every adjudication prompt, and reports prompt sizes and an
estimated token count and cost. Fully offline, costs nothing. This is the
default specifically so that running the script bare — `bun bench/e2e.ts`,
no flags — can never spend money by accident.

`findingsByVerdict` / `findingsBySeverity` / the per-family precision proxy
are all absent in this mode's report (JSON keys omitted, not zeroed) —
there's no adjudication in `dry` mode, so "confirmed" has no meaning yet.

### `replay`

Adjudication served from recorded fixtures in `bench/fixtures/responses/`
(override with `--fixtures-dir`), one JSON file per prompt, named by a hash
of that prompt. Deterministic, offline, free — this is the CI / regression
mode: it's what makes the non-deterministic adjudication stage testable at
all. A prompt with no matching fixture is reported by name (`filePath` +
the expected fixture filename) in the `Missing fixtures` section, never
silently skipped or sent live. If any fixture is missing, `--mode replay`
exits `1`.

### `live`

Real adjudication through `adjudicateBatch` (`../src/sandbox/agentos-runner.ts`)
— one disposable agentOS VM session per prompt, routed to the `anthropic`
provider through the `pi` ACP adapter. This is the one mode that can spend
real money; see "Cost safety" below for the gate it has to pass before it
does anything.

`--record` saves each live response as a new replay fixture (same hash-keyed
naming `replay` reads), so a `live --record` run seeds the fixtures the next
`replay` run — or CI — will use.

## Cost safety

This is the one script in the package that can spend real money, so its
defaults and gates are deliberately layered rather than resting on any
single check:

1. **`dry` is the default mode.** Running the script with no flags at all
   can never spend anything — there is no flag combination that reaches a
   model call without `--mode live` named explicitly.
2. **`--mode live` alone still refuses to run.** It additionally requires
   `--yes-spend`. Before checking that flag (or anything else), it prints
   the candidate count, prompt-wave count, and the heuristic cost estimate
   — so the refusal message and the "would-be" cost are visible even when
   you're intentionally testing the gate.
3. **The credential is checked for presence only, never read.** `--api-key-env`
   names an environment variable (default `ANTHROPIC_API_KEY`); the script
   checks `process.env[name] !== undefined && .trim().length > 0` and
   nothing else. The value itself is never logged, echoed, written to a
   fixture, or passed anywhere except forwarded by name to the sandbox
   runner, which reads it directly from `process.env` on its own. If the
   env var is absent, `--mode live` fails with a message naming the env var
   — never a silent fallback that could look like success.
4. **`--max-cost-usd` is a hard stop, checked twice over:**
   - **Pre-flight**, against the *total* estimated cost across every prompt
     wave, before the first model call. Combine with `--limit-files` to
     shrink scope instead.
   - **Between every wave**, against `runningCostUsd + thisWave.estimatedCostUsd`.
     A long run that would tip over the cap on, say, wave 6 of 10 stops
     after wave 5 completes — it never starts a wave whose own estimated
     cost would breach the cap, and never checks only once at the start.
     A run stopped this way still reports the findings gathered so far
     (`stoppedEarly.reason` explains why) rather than discarding them.

None of this replaces judgment — the cost estimate is a heuristic (see
"Estimated cost" below), not a metered guarantee, since neither
`adjudicateInSandbox` nor `adjudicateBatch` currently returns real
token-usage accounting. Treat `--max-cost-usd` as a backstop against a
scope mistake (the wrong `--project`, a missing `--limit-files`), not as a
precise budget.

## Recording fixtures

Two ways to get a fixture into `bench/fixtures/responses/`:

- **`--mode live --record`** — the normal path. Run live against real
  candidates (with `--limit-files` and `--max-cost-usd` to keep it small),
  and every successfully-adjudicated prompt is saved as
  `bench/fixtures/responses/<sha256-of-system+prompt>.json` automatically.
- **Hand-authored** — for a small, deliberately-curated fixture set (like
  the demo project below), write the JSON file yourself. The shape is:

  ```json
  {
    "filePath": "demo.ts",
    "prompt": "<the exact prompt text this fixture answers — must match what buildAdjudicationPrompt() produces for this file/candidates>",
    "raw": "<the model's raw response text, e.g. a JSON array of finding objects — this is what parseAdjudicationResponse() will parse>"
  }
  ```

  The filename must be the fixture key — `sha256(ADJUDICATION_SYSTEM_PROMPT
  + " " + prompt)`, hex-encoded — which is also what `replay` mode reports
  in its `Missing fixtures` list, so the easiest way to get the filename
  right is to run `--mode replay` once, copy the expected key it reports
  for the file you're authoring, and name the fixture accordingly. The
  `prompt` field inside the JSON is not itself re-hashed by `replay` (the
  filename is the lookup key); it's kept in the fixture purely as a
  human-readable record of what was asked.

### The demo project (`bench/fixtures/demo-project/`)

A tiny, permanent, three-file smoke-test project checked into the package
alongside three hand-authored fixtures answering it — one candidate per
file, one of each verdict:

| File        | Family         | Fixture verdict | Why                                                          |
| ----------- | -------------- | ---------------- | ------------------------------------------------------------- |
| `demo.ts`   | sql-injection  | confirmed         | Unescaped string interpolation directly into a SQL template.  |
| `demo2.ts`  | auth-bypass    | false-positive    | The env-check branch is dead code in production (commented).  |
| `demo3.ts`  | secret-in-log  | needs-context     | Whether `headers` carries a credential isn't visible here.    |

Reproduce it:

```bash
bun bench/e2e.ts --mode replay --project bench/fixtures/demo-project --project-id demo
```

Expect zero missing fixtures and `confirmed=1 false-positive=1 needs-context=1`.
This is the fastest way to sanity-check the whole pipeline — including the
parser's confidence-floor/failureScenario enforcement, since the three
fixtures exercise all three verdicts — without touching a real project or
spending anything. It's also a template for adding more hand-authored
fixtures: copy the pattern (a tiny synthetic file that trips exactly the
matcher you want, a fixture with a deliberately chosen verdict) rather than
inventing a new convention.

## Reading the report

Same shape whether printed to the console, emitted as `--json`, or written
as a `--out <path>` Markdown file — the renderers differ, the data doesn't.

- **Scan** — files scanned, files with candidates, files considered (after
  `--limit-files`), total candidates found.
- **Candidates by family** — one row per `vulnSlug`, with its `noiseTier`
  and (outside `dry` mode) `confirmed/findings` and the **precision proxy**:
  the share of that family's adjudicated candidates that came back
  `confirmed`. Read this as a per-matcher signal, not a per-run one — it
  needs a real sample to mean anything, which is why **zero-confirmed
  families** are only called out when `findings >= 5` for that family (see
  `LARGE_SAMPLE_THRESHOLD` in `bench/e2e.ts`): a family sitting at 0%
  confirmed over a small handful of candidates is just as likely to be an
  unlucky sample as a bad matcher, but 0% over a large one is a real
  signal. When that threshold is crossed, the report says explicitly which
  family to delete or retune — that's a deliberate design choice, not a
  suggestion buried in a number: a matcher that never confirms is pure
  noise cost with no offsetting signal, and the report should say so
  louder than "confirmed 0/12 (0%)" on its own would.
- **Prompts** — wave count, prompt count (recall a wave can contain
  multiple files, and a single large file can be split across multiple
  waves — see the comment above `PromptUnit` in `bench/e2e.ts`), total/mean/max
  prompt size in characters, and the largest N prompts by size.
- **Estimated cost** — `~4 chars/token` is a heuristic, not a tokenizer;
  it's good enough to size a prompt and ballpark a cost, not a substitute
  for real usage accounting. Pricing comes from a small hardcoded table
  (`MODEL_PRICING_USD_PER_MTOK` in `bench/e2e.ts`, cached from the
  `claude-api` skill's rate card) keyed by model id; the sandbox transport's
  actual default model (`claude-sonnet-4-5`) isn't itself on the current
  rate card, so it's priced at the nearest known analog (the Sonnet 4.6/5
  rate) and flagged `approximated: true` in the report — override with
  `--price-input`/`--price-output` for an exact figure, or `--model` to
  price a different model's rate row.
- **Findings by verdict / by severity** — absent in `dry` mode (no
  adjudication happened). Severity is counted for `confirmed` findings
  only — a `false-positive` or `needs-context` finding's severity field is
  not meaningful (the parser always sets it to something, per the response
  schema, but nothing downstream should read it for a non-confirmed
  verdict, and the report doesn't either).
- **Missing fixtures / Recorded fixtures** — `replay` mode's coverage
  report, and `live --record`'s save log, respectively.
- **Stopped early** — present only when a `live` run hit `--max-cost-usd`
  mid-run; names which wave it stopped before and why.
- **Errors** — file-read failures during prompt construction, adjudication
  call failures, and response-parsing failures (`parseAdjudicationResponse`'s
  per-entry errors) all land here, prefixed by file path. A `dry` run can
  still report errors (e.g. a file that disappeared between scan and prompt
  build); it just never reports findings.
- **Stage timings** — wall-clock milliseconds for scan / batch / build-prompts
  / adjudicate / total. `adjudicate` is `0` in `dry` mode (nothing ran) and
  dominated by network/VM-boot latency in `live` mode.

## Flags reference

Run `bun bench/e2e.ts --help` for the authoritative, always-current list —
it's generated from the same source as this doc and won't drift from it.
Notable ones not explained above:

- `--project <path>` — the project root to scan. Defaults to
  `bench/fixtures/demo-project`, the small checked-in tree the replay
  fixtures were recorded against, so a bare `bun bench/e2e.ts` reproduces
  anywhere. Point it at real code to measure a real run.
- `--info <path>` — injects a file's contents as hand-curated project
  context into every adjudication prompt (the `info` field on
  `ProjectConfig` — see `buildAdjudicationPrompt` in `src/adjudication.ts`).
  No naming convention (e.g. `INFO.md`) is enforced anywhere in the
  package; this flag is opt-in and explicit, not auto-discovered.
- `--workspace-id <id>` — scopes the disposable agentOS VM(s) a live run
  boots. Defaults to a fresh generated id per invocation so concurrent
  `live` runs (yours, a teammate's, CI) never collide.
- `--concurrency <n>` / `--timeout-ms <n>` — forwarded as-is to
  `adjudicateBatch`; see its own doc comment in `src/sandbox/agentos-runner.ts`
  for what they control.
