# secondpass performance + ReDoS benchmark

`bench/perf.ts` measures the cost of the scan stage (`scanContent` /
`scanProject`, `src/scanner.ts`) and guards against catastrophic regex
backtracking in the matcher registry. It is a different tool from
`bench/evaluate.ts` (recall/precision against the labeled corpus in
`bench/corpus/` — see `bench/README.md`): this one asks "how fast, and does
anything hang," not "how accurate."

## Running it

```bash
bun bench/perf.ts                              # human-readable tables
bun bench/perf.ts --json                        # machine-readable report
bun bench/perf.ts --save bench/perf-baseline.json    # record this run as a baseline
bun bench/perf.ts --baseline bench/perf-baseline.json # diff this run against it
bun bench/perf.ts --help
```

`--save` and `--baseline` compose: a single invocation can both diff against
an old baseline and record a new one. Neither flag ever writes under
`bench/corpus/` — pick a path outside it (`bench/perf-baseline.json` is not
committed; treat it as a local/CI artifact, the same way `bench/evaluate.ts`
treats `bench/baseline.json`).

The suite runs against two corpora and `ALL_MATCHERS` — every matcher the
package ships, the same set a default scan runs. Defaults are checked in so
the command reproduces anywhere:

- **large** — `bench/corpus` (~94 files, ~400 KB)
- **small** — `src/matchers` (a handful of files)

Both are small. Throughput measured over a few hundred KB tells you the
suite works, not how the scanner behaves on a real repository — point
`--large <path>` at an actual source tree before recording a number you
intend to compare against later, and keep every baseline diff on the same
corpus.

## Reading the output

Six sections, printed in this order (ReDoS first — see "Run order" below):

### 4. ReDoS guard

Every regex in the composed registry, run against five adversarial inputs
(long runs of spaces, deeply-nested `${`, thousands of quotes, long
unclosed braces, a 100 KB single line with no newline), each in an isolated
worker with a hard wall-clock kill. A regex **FAILS** if it takes longer
than `REDOS_BUDGET_MS` (50 ms) against ANY input. A regex that doesn't even
return within `REDOS_HARD_KILL_MS` (2000 ms) is reported `KILLED` — the
worker is terminated so the benchmark itself keeps running.

**A ReDoS failure is a hard blocker. It is never a "known issue," never
something to note-and-move-on from, and it gates the exit code by itself
— nothing else in this suite needs to also be wrong for the run to fail.**
One hanging regex wedges a whole scan on one weird minified file in
production; that failure mode is worse than any throughput number this
suite reports. If you see a FAILURE here, fix the regex (bounded
quantifiers, anchored character classes, no nested unbounded groups)
before doing anything else with the matcher.

### 1. Throughput

`scanProject` over each corpus: one cold run (discarded from the median,
reported separately as "the JIT-warmup number"), then `WARM_RUN_COUNT` (5)
warm reps. The table reports the **median** warm rep, not the mean — a
single GC pause during one rep would skew a mean; the median shrugs it off.
`files/s` and `MB/s` are derived from that same median rep's duration, so
they stay internally consistent with each other.

### 2. Per-matcher cost

Total regex time and time-per-KB for each matcher family across the large
corpus, ranked most-expensive-first. This is the main optimization input:
a family costing a large share of total runtime for a small file count is
the one worth profiling first. `Share` is each family's percentage of the
sum of all families' `Total ms` (not of throughput's wall-clock duration —
see "Why per-matcher time doesn't sum to throughput duration" below).

### 3. Per-pattern cost within the top 3 families

The same measurement, drilled into the individual `{ regex, label }`
patterns of the 3 most expensive families from section 2. `Share of
family` is that pattern's percentage of its own family's total, so it
answers "which one regex do I fix," not just "which family."

A pattern shows `SKIPPED (ReDoS)` instead of a number if it was `KILLED` in
section 4 — it is never run against real files on the main thread once
it's proven capable of hanging a thread; see "Run order" below.

### 5. Scaling curve

`scanContent` (full composed registry) against synthetic source at 1 KB /
10 KB / 100 KB / 1 MB, median of 3 reps, run in the same isolated worker as
section 4 (so a genuinely superlinear pattern can't hang this section
either — `SCALING_HARD_KILL_MS`, 15 s, gives a legitimately-slower-but-not-
hung 1 MB scan room to finish and still be measured). `Exponent vs prev` is
`ln(t2/t1) / ln(s2/s1)` between consecutive size steps — 1.0 is perfectly
linear. The verdict is `SUPERLINEAR` if any exponent exceeds
`SCALING_SUPERLINEAR_EXPONENT_THRESHOLD` (1.3, with headroom for
measurement noise at the sub-millisecond end of the curve).

**Superlinear growth is a bug, not a tuning opportunity.** It means some
pattern is backtracking on longer input, not just running slower per byte.
Don't respond to a `SUPERLINEAR` verdict by "optimizing" — find which
pattern's growth exponent is off (cross-reference section 4 for the same
pattern against the fixed-size adversarial inputs) and fix the regex.

### 6. Memory

Peak RSS (`process.memoryUsage().rss`, sampled every 10 ms) during one
full-tree scan of the large corpus, plus before/after/delta. `Bun.gc(true)`
runs first (if available) so the "before" number is a real baseline, not
whatever garbage happened to still be resident from the previous section.

### Baseline comparison (only with `--baseline`)

Six metrics, each compared against the loaded baseline report:

| Metric | Direction | Tolerance | Gates exit code? |
| --- | --- | --- | --- |
| large corpus files/sec (warm median) | higher is better | 20% | **yes** |
| large corpus MB/sec (warm median) | higher is better | 25% | no |
| small corpus files/sec (warm median) | higher is better | 20% | **yes** |
| total matcher regex time (large corpus) | lower is better | 25% | no |
| peak RSS during full-tree scan | lower is better | 25% | no |
| scaling curve ms/KB @ 1 MB | lower is better | 25% | no |

Each gets a verdict: `IMPROVED`, `REGRESSED`, or `NO CHANGE` — `NO CHANGE`
whenever the delta is within tolerance, regardless of sign. A missing or
unparseable `--baseline` file prints a warning and the run proceeds without
comparisons (exit code then depends only on the ReDoS guard).

## Tolerances — why they're this wide, and where they live

Two named constants in `bench/perf.ts` drive every pass/fail line:

- `REDOS_BUDGET_MS = 50` — the ReDoS FAILURE line. Not a tolerance; a hard
  correctness threshold from the task spec.
- `THROUGHPUT_REGRESSION_TOLERANCE = 0.2` (20%) — the **gating** tolerance,
  applied only to files/sec on both corpora.
- `INFO_REGRESSION_TOLERANCE = 0.25` (25%) — applied to every other,
  non-gating comparison.

This suite runs on a shared development machine, not isolated CI hardware.
File-system cache state, background processes, and GC scheduling alone can
swing a warm-median throughput number by double digits between two
back-to-back runs with zero code changes — the two `NO CHANGE` runs during
this suite's own verification showed ±5–18% swings on identical code.
**A tolerance narrow enough to catch real regressions but also narrow
enough to fire on that noise is worse than no gate at all** — a benchmark
that cries wolf gets its failures ignored by habit, and then it isn't
gating anything. 20% is wide enough to absorb that noise on this hardware
while still catching an actual regression (a genuinely slower matcher
doesn't get 20% slower by accident).

If this suite starts running in a more controlled environment (dedicated
CI runner, pinned CPU), these constants are the two lines to tighten — do
not tighten them without first collecting a few consecutive `NO CHANGE`
baselines-vs-current runs on that environment to see what the real noise
floor is there.

## Run order (and why it's not top-to-bottom by section number)

The ReDoS guard (section 4) runs **first**, before sections 1–3 touch a
single real corpus file. Its output — specifically, which `(matcherSlug,
label)` patterns got `KILLED` (hard-timed-out in the isolated worker) —
feeds directly into sections 2 and 3: a killed pattern is never executed
against real corpus content on the main thread. This is deliberate defense
in depth: a pattern that's already proven capable of hanging a thread on
adversarial input should not get a second chance to do it on the main
thread just because real source code is "supposed to be" well-behaved.
(Patterns that merely exceed the 50 ms budget without being killed — slow
on adversarial input but finite — are NOT skipped; they run normally
against real files, since a worst-case-adversarial timing says nothing
about typical-file cost.)

Sections 1–3 and 6 (throughput, matcher cost, pattern cost, memory) run
directly on the main thread against real corpus files, unguarded by worker
isolation — real source is not adversarial input, and isolating every file
read would defeat the point of measuring realistic cost. Section 5
(scaling curve) uses the same worker isolation as section 4, since its
synthetic input sizes go up to 1 MB and a pattern that's fine on 180 real
files could still, in principle, behave differently on a much larger
single input.

## Why per-matcher time doesn't sum to throughput duration

Section 2's `Total ms` per matcher, summed across all matchers, is **regex
execution time only** — no file I/O, no glob matching, no line-number
math, no candidate deduplication. Section 1's throughput duration is
**wall-clock time for the whole `scanProject` call** — every one of those
things, for every file, including the ones `scanProject` reads and then
skips (oversized, binary, or matched by `DEFAULT_IGNORE`). Don't expect
these two numbers to reconcile; they're deliberately measuring different
things; comparing regex-only cost against end-to-end wall-clock cost is
what tells you whether a slow scan is a regex problem or an I/O problem.

## Using `Bun.nanoseconds()`

Every duration in this suite is measured with `Bun.nanoseconds()` (a
monotonic nanosecond counter), converted to milliseconds only for display —
including inside the isolated worker, which computes its own timings the
same way before posting them back. `process.memoryUsage()` and the memory
sampling interval are the one exception (wall-clock sampling cadence, not
a duration measurement).

## Standing rule

**A ReDoS failure is a hard blocker.** If `bun bench/perf.ts` reports any
FAILURE in section 4, treat it exactly like a failing test: stop, fix the
regex, re-run. Do not merge, deploy, or file it as a "known issue" —
scan-stage regexes run over every file in every repo this package ever
scans, unattended, and a pattern that can be walked into a multi-second
(or worse) stall on one weird minified file takes the whole run down with
it. There is no severity tier below "fix it now" for this category.
