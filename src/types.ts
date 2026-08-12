/**
 * secondpass contracts — the seam between the deterministic scan stage,
 * the actor orchestration layer, and the agentOS adjudication stage.
 *
 * Two stages, deliberately separated:
 *
 *   scan      free, deterministic, regex-only. Emits `Candidate`s.
 *   adjudicate  costed, model-driven. Turns `Candidate`s into `Finding`s.
 *
 * A candidate is NOT a vulnerability. It is a location worth a model's
 * attention. Most candidates are noise; that is by design — the scan
 * stage is tuned for recall, adjudication for precision.
 *
 * Architecture derived from deepsec (Apache-2.0) — see NOTICE.
 */

/**
 * How much noise a matcher is expected to produce.
 *
 * Adjudication uses this to set its prior: a `high` tier match starts
 * from "probably nothing, prove otherwise". Purely advisory to the
 * scan stage — it never suppresses a match, it only annotates one.
 */
export type NoiseTier = "low" | "normal" | "high";

/** One regex and the human-readable reason it fires. */
export interface MatcherPattern {
  regex: RegExp;
  /** Shown to the adjudicating model as `matchedPattern`. */
  label: string;
  /**
   * Drop the match if the character immediately before it matches this.
   * A cheap, declarative stand-in for a leading negative lookbehind.
   *
   * Prefer this over writing `(?<!…)` at the START of `regex`. A pattern
   * that opens with a lookbehind cannot be optimized by the engine's
   * literal-prefix scan, so instead of skipping to the next plausible
   * offset it evaluates the assertion at every character in the file.
   * Measured on 1.7 MB of real TypeScript: `/(?<![.\w$])(?:exec|execSync)…/`
   * took 28.3 ms; the identical pattern as `/\b(?:exec|execSync)…/` plus
   * `notPrecededBy: /[.\w$]/` took 0.7 ms. Same matches, 40x cheaper.
   *
   * Checked against exactly one character; a match at offset 0 always
   * passes.
   */
  notPrecededBy?: RegExp;
  /**
   * Require this capture group to land on real code — not inside a string
   * literal or a comment. `0` means the whole match.
   *
   * For patterns that span a call and then look for a keyword deep inside
   * it, the match START is always code (`logger.error(`) while the part
   * that actually decided the match may be prose. Measured on a real
   * codebase, most `secret-in-log` hits were words like `session` or
   * `secret` sitting in log TEXT — `` `… secretHeader=${hasFlag}` `` —
   * not identifiers carrying a credential. This pins the check to the
   * group that matters.
   *
   * Requires the group to be a real capture group in `regex`.
   */
  codeOnlyGroup?: number;
}

/** A named family of related patterns (one `vulnSlug`). */
export interface Matcher {
  /** Stable kebab-case id, e.g. `auth-bypass`. Becomes `Candidate.vulnSlug`. */
  slug: string;
  description: string;
  noiseTier: NoiseTier;
  /** Bun.Glob patterns, matched against the repo-relative path. */
  filePatterns: string[];
  /** Illustrative hits — injected into the adjudication prompt. */
  examples?: string[];
  patterns: MatcherPattern[];
}

/** A location a matcher flagged. Not yet a finding. */
export interface Candidate {
  vulnSlug: string;
  /** 1-indexed. */
  lineNumbers: number[];
  /** The matched line plus surrounding context. */
  snippet: string;
  matchedPattern: string;
  noiseTier: NoiseTier;
}

export interface ScannedFile {
  /** Repo-relative, POSIX separators. */
  filePath: string;
  /** Content hash — lets a re-scan skip unchanged files. */
  fileHash: string;
  candidates: Candidate[];
}

export interface ScanResult {
  runId: string;
  projectId: string;
  rootPath: string;
  filesScanned: number;
  candidatesFound: number;
  files: ScannedFile[];
  /** Wall-clock milliseconds. */
  durationMs: number;
}

/**
 * The adjudicated outcome for one candidate.
 *
 * `needs-context` is a first-class answer, not a failure. A model that
 * cannot see the callers of a helper should say so rather than guess —
 * a confident wrong verdict costs more than an honest abstention.
 */
export type Verdict = "confirmed" | "false-positive" | "needs-context";

export type Severity = "critical" | "high" | "medium" | "low";

export interface Finding {
  vulnSlug: string;
  filePath: string;
  lineNumbers: number[];
  verdict: Verdict;
  /** Only meaningful when `verdict === "confirmed"`. */
  severity: Severity;
  /** One sentence: the defect itself. */
  summary: string;
  /** Why the verdict holds — the reasoning that must survive review. */
  rationale: string;
  /** Concrete inputs/state → wrong outcome. Empty for false positives. */
  failureScenario: string;
  /** 0–1. Below `CONFIDENCE_FLOOR` the finding is held back for review. */
  confidence: number;
}

/** Findings below this confidence are not surfaced as confirmed. */
export const CONFIDENCE_FLOOR = 0.6;

/** One scannable codebase. */
export interface ProjectConfig {
  /** Stable id, e.g. `api`. Namespaces runs and findings. */
  id: string;
  /** Absolute path to the project root. */
  root: string;
  /**
   * Hand-curated context injected into every adjudication prompt.
   *
   * This is the single highest-leverage input to finding quality. It
   * carries what a reviewer could not infer from the file alone:
   * internal auth primitives by name, the actual threat model, and the
   * intentional-looking-dangerous patterns that would otherwise burn a
   * model's attention on the same false positives every run.
   */
  info?: string;
  /** Extra ignore globs, on top of {@link DEFAULT_IGNORE}. */
  ignore?: string[];
}

/** Never scanned. Build output and vendored trees drown the signal. */
export const DEFAULT_IGNORE: readonly string[] = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/.svelte-kit/**",
  "**/.turbo/**",
  "**/coverage/**",
  "**/target/**",
  "**/*.min.js",
  "**/*.map",
  "**/bun.lock",
  "**/package-lock.json",
];
