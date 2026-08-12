# secondpass ground-truth corpus

This is the labeled evaluation corpus for the scan stage (`scanContent` in
`src/scanner.ts`, matchers in `src/matchers/builtin.ts`). It exists because
**counting candidates measures nothing.** A matcher that fires on every
`fetch(` call has 100% recall and is worthless. The only way to know whether
`secondpass`'s regexes are any good is to run them against code where the
right answer is already known, and score the disagreements. That's what
this directory is.

## Contract

```
bench/corpus/
  manifest.json          the labels — the source of truth
  positive/<slug>/*.ts   files containing a REAL instance of that vulnerability
  negative/<slug>/*.ts   SAFE code that superficially looks like that vulnerability
```

`<slug>` is one of the 12 builtin matcher families in `src/matchers/builtin.ts`:
`auth-bypass`, `sql-injection`, `ssrf`, `secret-in-log`, `xss`,
`unsafe-redirect`, `cors-wildcard`, `jwt-handling`, `insecure-crypto`, `rce`,
`non-atomic-read-delete`, `test-header-bypass`.

`manifest.json` is a flat list of cases:

```json
{ "file": "positive/sql-injection/interpolated-where.ts",
  "expect": "hit", "slug": "sql-injection", "line": 10,
  "note": "user-controlled email interpolated into a WHERE clause" }
```

- `file` — path relative to `bench/corpus/`.
- `expect` — `"hit"` (a candidate for `slug` must appear at `line`) or
  `"miss"` (no candidate for `slug` should appear anywhere in the file).
- `slug` — which matcher family this case labels. A file may contain code
  that happens to trip a *different* matcher too — that's fine and expected;
  the case only asserts about its own `(file, slug)` pair.
- `line` — **only present on `"hit"` cases.** 1-indexed, and it is the
  `startLine` a correctly-behaving matcher's `Candidate.lineNumbers[0]`
  should equal — not just "the line a human would point to". Every `line`
  in this manifest was captured by actually running `scanContent` against
  the fixture and reading back the real candidate, except for the one
  known miss (see `KNOWN MISSES` below), where it is the line a security
  engineer would flag by hand.
- `note` — one sentence: what makes this case a real hit or a safe miss.

An eval harness reads `manifest.json`, runs `scanContent` per file, and
compares. Nothing in this directory is ever imported or executed as code —
every fixture opens with `// secondpass corpus fixture — not executed. See
bench/corpus/manifest.json` for exactly that reason, and `bench/corpus` is
excluded from the package's `tsconfig.json` so these deliberately-suspicious
files never fail `tsc`.

## Why hard negatives are the point

Any regex finds `eval(`. The skill being measured is **not** firing on:

- `// never use eval(` — inside a comment
- `evaluate(formula, scope)` — a similarly-named, unrelated API
- `"eval("` — inside a string literal
- `execSync("git status --porcelain")` — a hardcoded constant, not user input
- `container.innerHTML = DOMPurify.sanitize(x)` — already wrapped in the
  correct escaping/validation helper

A corpus of only positives cannot detect a matcher that fires unconditionally
— it would score 100% either way. Every family here carries a **1:1**
positive:negative ratio (4 and 4, currently), and every family's negatives
hit at least two of the five classic false-positive sources above. Roughly
a third of the negatives in this corpus are *not* correctly ignored by the
current matchers — see `KNOWN MISSES` in the eval report. That is the
expected, useful output of a corpus built this way: it exists to find those
cases, not to hide them.

## Adding a case

1. Pick the family (`slug`) and decide positive or negative.
2. Write a small, realistic file under `positive/<slug>/` or
   `negative/<slug>/` — a plausible route handler, DB access function, or
   auth check, not a bare one-line toy. Start it with the fixture header
   comment.
3. For a **positive**, make sure exactly one vulnerable site exists and is
   unambiguous — a security engineer reading the file should be able to
   point at the one bad line without hesitation.
4. For a **negative**, make it a case a naive regex would plausibly trip on
   — reuse one of the five classic categories above. A negative that no
   reasonable matcher would ever flag isn't testing anything.
5. Verify against the real scanner before writing the manifest line:

   ```ts
   import { scanContent } from "../../src/scanner.js";
   import { BUILTIN_MATCHERS } from "../../src/matchers/builtin.js";

   const candidates = scanContent({
     filePath: "positive/<slug>/<file>.ts",
     content: await Bun.file("bench/corpus/positive/<slug>/<file>.ts").text(),
     matchers: BUILTIN_MATCHERS,
   });
   console.log(candidates);
   ```

   For a positive, copy the real `lineNumbers[0]` into the manifest's
   `line` field — don't hand-guess it. If no candidate for your slug shows
   up, that's not a reason to tweak the fixture until the matcher happens
   to catch it (see below) — it's a real miss; label it as `"hit"` anyway,
   with the line you'd flag by hand, and call it out separately.
6. Add the entry to `manifest.json`, keeping the file grouped with its slug.
7. Never edit a matcher in `src/matchers/` to make a corpus case pass. This
   corpus measures the matchers; it does not exist to be measured by them.
   A discovered gap belongs in the matcher's own backlog, decided on its
   own merits — not patched reflexively to turn a red row green here.

## Non-`.ts` fixtures

Two `xss` fixtures are `.svelte` files (`{@html}` is Svelte-specific and the
`xss` matcher's `filePatterns` explicitly covers `**/*.svelte`) — excluding
Svelte entirely would leave that pattern permanently untested. Every other
fixture is plain `.ts`.
