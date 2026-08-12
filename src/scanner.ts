/**
 * The scan stage — free, deterministic, regex-only. See the header comment
 * in types.ts for why this is split from adjudication.
 *
 * `scanContent` is the pure core: given one file's content, it decides
 * which matchers apply (by path), runs every pattern, and returns deduped
 * `Candidate`s. `scanProject` is the thin I/O shell around it — walking
 * the tree, filtering ignores, and reading files with Bun's native APIs.
 * Neither function may call a model or reach the network; that boundary
 * is the entire reason this stage exists separately from adjudication.
 */

import type { BunFile } from "bun";
import type {
  Candidate,
  Matcher,
  NoiseTier,
  ProjectConfig,
  ScannedFile,
  ScanResult,
} from "./types.js";
import { findLiteralRanges, isInsideComment } from "./comments.js";
import { DEFAULT_IGNORE } from "./types.js";
import { ALL_MATCHERS } from "./matchers/index.js";

/**
 * Files above this size are almost never hand-authored source — vendored
 * bundles and generated artifacts that dodged {@link DEFAULT_IGNORE} live
 * here. Skip the read rather than pay to regex-scan a bundle for garbage
 * candidates.
 */
const MAX_FILE_SIZE_BYTES = 1.5 * 1024 * 1024;

/** How much of a file we sniff for a NUL byte before treating it as binary. */
const BINARY_SNIFF_BYTES = 8192;

/** Lines of context on each side of a match, for {@link Candidate.snippet}. */
const SNIPPET_CONTEXT_LINES = 2;

/**
 * Hard cap on `Candidate.snippet` length. A single match can legitimately
 * span many lines (several builtin patterns use `[^}]{0,120}`, which
 * crosses newlines) — this stops a pathological span from ballooning the
 * payload handed to adjudication.
 */
const MAX_SNIPPET_CHARS = 600;

/**
 * Compiled `Bun.Glob` instances per matcher, keyed by matcher identity.
 *
 * A repo-sized scan tests every (matcher, filePattern) pair against every
 * walked file — thousands of files times dozens of patterns. Recompiling a
 * `Bun.Glob` on each test would dominate scan time; a `WeakMap` compiles
 * each matcher's patterns exactly once and lets the entry go once the
 * matcher itself is no longer referenced.
 */
const globCache = new WeakMap<Matcher, Bun.Glob[]>();

function compiledGlobs(matcher: Matcher): Bun.Glob[] {
  let globs = globCache.get(matcher);
  if (!globs) {
    globs = matcher.filePatterns.map((pattern) => new Bun.Glob(pattern));
    globCache.set(matcher, globs);
  }
  return globs;
}

/** Does this matcher's `filePatterns` cover the given repo-relative path? */
function matcherAppliesToFile(matcher: Matcher, filePath: string): boolean {
  return compiledGlobs(matcher).some((glob) => glob.match(filePath));
}

/**
 * Turn a matcher pattern into a fresh, always-global `RegExp`.
 *
 * The trap this guards against: `matcher.patterns[].regex` is a single
 * `RegExp` object shared by every matcher and reused across every file in
 * the scan (matchers are typically a module-level constant, e.g.
 * `BUILTIN_MATCHERS`). If we called `.exec()` on that shared object
 * directly, its `lastIndex` would carry over between files — a match late
 * in file A leaves `lastIndex` past the end of file B, and file B silently
 * reports zero matches even though the pattern is present. Building a new
 * `RegExp` per (file, pattern) call sidesteps the shared mutable state
 * entirely; regex compilation is cheap next to the file I/O around it, and
 * it also lets us force the `g` flag onto patterns that were written
 * without one (every builtin pattern is `g`-less — they were authored as
 * "does this line look like X", not "find every X").
 */
function toGlobalRegex(regex: RegExp, needIndices: boolean): RegExp {
  let flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  // `d` is added only when a pattern actually asks for group offsets —
  // hasIndices makes the engine record every group's span on each match.
  if (needIndices && !flags.includes("d")) flags += "d";
  return new RegExp(regex.source, flags);
}

/**
 * Byte-offset -> 1-indexed line number, via a precomputed line-start table.
 *
 * Building this array once per file (in {@link scanContent}) and binary
 * searching it per match keeps a file with many matches at O(n + m log n).
 * The obvious alternative — re-splitting the content, or rescanning from
 * offset 0, on every match — is O(n*m) and is exactly the trap called out
 * for this file: a 4k-line file with 60 matches must not pay for 60 full
 * passes over the content just to find line numbers.
 */
function computeLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10 /* "\n" */) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function offsetToLine(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo + 1;
}

function buildSnippet(params: { lines: string[]; startLine: number; endLine: number }): string {
  const { lines, startLine, endLine } = params;
  const from = Math.max(1, startLine - SNIPPET_CONTEXT_LINES);
  const to = Math.min(lines.length, endLine + SNIPPET_CONTEXT_LINES);
  const snippet = lines.slice(from - 1, to).join("\n");
  return snippet.length > MAX_SNIPPET_CHARS
    ? `${snippet.slice(0, MAX_SNIPPET_CHARS)}…`
    : snippet;
}

function lineRange(startLine: number, endLine: number): number[] {
  const range: number[] = [];
  for (let line = startLine; line <= endLine; line += 1) {
    range.push(line);
  }
  return range;
}

/** One surviving hit per (vulnSlug, starting line) — the dedupe unit. */
interface Site {
  vulnSlug: string;
  noiseTier: NoiseTier;
  label: string;
  startLine: number;
  endLine: number;
  matchLength: number;
}

/**
 * The pure, unit-testable scan core — no filesystem access. Hand it a path
 * and its already-loaded content and it returns candidates.
 *
 * `filePath` is used only to gate which matchers apply (via
 * `filePatterns`); it never appears on the returned `Candidate`s — that's
 * `ScannedFile.filePath`'s job, one layer up.
 */
export function scanContent(params: {
  filePath: string;
  content: string;
  matchers: readonly Matcher[];
}): Candidate[] {
  const { filePath, content, matchers } = params;

  const applicable = matchers.filter((matcher) => matcherAppliesToFile(matcher, filePath));
  if (applicable.length === 0) {
    return [];
  }

  const lineStarts = computeLineStarts(content);
  const lines = content.split("\n");

  // Computed once per file, not once per pattern — with ~60 patterns this
  // is the difference between one lex and sixty.
  const { comments: commentRanges, strings: stringRanges } = findLiteralRanges(content);

  const bySite = new Map<string, Site>();

  for (const matcher of applicable) {
    for (const pattern of matcher.patterns) {
      const regex = toGlobalRegex(pattern.regex, pattern.codeOnlyGroup !== undefined);
      let match = regex.exec(content);
      while (match !== null) {
        const matchLength = match[0].length;
        if (matchLength === 0) {
          // A zero-width pattern (pure lookaround, no consumed chars)
          // would otherwise pin lastIndex in place and loop forever;
          // step past it by hand. None of the builtin patterns are
          // zero-width today, but a future matcher could be.
          regex.lastIndex += 1;
          match = regex.exec(content);
          continue;
        }

        // Declarative stand-in for a leading negative lookbehind — see
        // MatcherPattern.notPrecededBy for why this lives here and not in
        // the regex.
        if (pattern.notPrecededBy && match.index > 0) {
          const preceding = content[match.index - 1]!;
          if (pattern.notPrecededBy.test(preceding)) {
            match = regex.exec(content);
            continue;
          }
        }

        // The group that decided this match must be live code, not prose
        // inside a string or comment.
        if (pattern.codeOnlyGroup !== undefined) {
          const span = (match as RegExpExecArray & {
            indices?: Array<[number, number] | undefined>;
          }).indices?.[pattern.codeOnlyGroup];
          if (
            span &&
            (isInsideComment(stringRanges, span[0]) ||
              isInsideComment(commentRanges, span[0]))
          ) {
            match = regex.exec(content);
            continue;
          }
        }

        // Code quoted inside a comment is documentation, not a defect.
        // Keyed on where the match STARTS: a match that begins in live
        // code and runs into a trailing comment is still live code.
        if (isInsideComment(commentRanges, match.index)) {
          match = regex.exec(content);
          continue;
        }

        const startLine = offsetToLine(lineStarts, match.index);
        const endLine = offsetToLine(lineStarts, match.index + matchLength - 1);
        const key = `${matcher.slug}#${startLine}`;
        const existing = bySite.get(key);

        // Dedupe: one candidate per vulnSlug per starting line. Prefer
        // whichever pattern matched more text — a longer match pulls in
        // more of the surrounding syntax (e.g. auth-bypass's "environment
        // check gating a path" pattern vs. its bare "identifier names an
        // auth skip" pattern), which is the cheapest reliable proxy for
        // "more specific" without a hand-maintained ranking table per
        // matcher.
        if (!existing || matchLength > existing.matchLength) {
          bySite.set(key, {
            vulnSlug: matcher.slug,
            noiseTier: matcher.noiseTier,
            label: pattern.label,
            startLine,
            endLine,
            matchLength,
          });
        }

        match = regex.exec(content);
      }
    }
  }

  const candidates = Array.from(bySite.values(), (site) => ({
    vulnSlug: site.vulnSlug,
    lineNumbers: lineRange(site.startLine, site.endLine),
    snippet: buildSnippet({ lines, startLine: site.startLine, endLine: site.endLine }),
    matchedPattern: site.label,
    noiseTier: site.noiseTier,
  }));

  // Deterministic order regardless of matcher/pattern iteration order —
  // callers (and tests, and diffing re-scans) shouldn't see candidates
  // shuffle between runs.
  candidates.sort(
    (a, b) => a.lineNumbers[0] - b.lineNumbers[0] || a.vulnSlug.localeCompare(b.vulnSlug),
  );
  return candidates;
}

function hashContent(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

/**
 * Sniff the first {@link BINARY_SNIFF_BYTES} for a NUL byte rather than
 * decoding the whole file — binaries and minified bundles that dodged
 * {@link DEFAULT_IGNORE} are the target, and a NUL in valid UTF-8 source
 * essentially never happens.
 */
async function looksBinary(file: BunFile): Promise<boolean> {
  const head = await file.slice(0, BINARY_SNIFF_BYTES).bytes();
  return head.includes(0);
}

/**
 * Walk `project.root`, apply every matcher to every file it could
 * plausibly fire on, and return the raw candidates. Free and
 * deterministic — this function must never call a model or reach the
 * network; that's the entire reason it's a separate stage from
 * adjudication (see the header comment in types.ts).
 *
 * Note on ignore handling: `Bun.Glob` has no directory-pruning option, so
 * `DEFAULT_IGNORE` / `project.ignore` are applied as a post-walk filter
 * per yielded path rather than by skipping traversal into (say)
 * `node_modules` outright. For a project root scoped to a single app or
 * package this is unmeasurable; scanning a root that itself contains a
 * large `node_modules` will still pay Bun's (fast, native) directory-walk
 * cost for those files before they're filtered out.
 */
export async function scanProject(params: {
  project: ProjectConfig;
  matchers?: readonly Matcher[];
  runId: string;
}): Promise<ScanResult> {
  const { project, matchers = ALL_MATCHERS, runId } = params;
  const start = performance.now();

  const ignoreGlobs = [...DEFAULT_IGNORE, ...(project.ignore ?? [])].map(
    (pattern) => new Bun.Glob(pattern),
  );
  const root = project.root.endsWith("/") ? project.root.slice(0, -1) : project.root;

  const files: ScannedFile[] = [];
  let filesScanned = 0;
  let candidatesFound = 0;

  const walker = new Bun.Glob("**/*");
  for await (const relPath of walker.scan({ cwd: root, dot: false })) {
    // Bun.Glob yields posix separators on the platforms this repo ships
    // to (Bun is macOS/Linux-only here); normalize defensively so glob
    // matching and the ScannedFile.filePath contract stay honest.
    const filePath = relPath.replaceAll("\\", "/");

    if (ignoreGlobs.some((glob) => glob.match(filePath))) {
      continue;
    }

    // Skip the read entirely for files no matcher targets (images, fonts,
    // lockfiles that dodged DEFAULT_IGNORE, …) — this is the majority of
    // files in most repos, and the read is the expensive part.
    if (!matchers.some((matcher) => matcherAppliesToFile(matcher, filePath))) {
      continue;
    }

    const bunFile = Bun.file(`${root}/${filePath}`);

    try {
      // Counted here, unconditionally, so a file that turns out to be
      // oversized/binary/unreadable is still reflected in filesScanned —
      // it was genuinely attempted, it just produced zero candidates.
      filesScanned += 1;

      if (bunFile.size > MAX_FILE_SIZE_BYTES) {
        continue;
      }
      if (await looksBinary(bunFile)) {
        continue;
      }

      const content = await bunFile.text();
      const candidates = scanContent({ filePath, content, matchers });
      if (candidates.length > 0) {
        candidatesFound += candidates.length;
        files.push({
          filePath,
          fileHash: hashContent(content),
          candidates,
        });
      }
    } catch {
      // The file vanished or became unreadable mid-walk — this repo is
      // worked on by parallel agents/processes as a matter of course.
      // Skip it rather than fail the whole run over one file.
      continue;
    }
  }

  return {
    runId,
    projectId: project.id,
    rootPath: project.root,
    filesScanned,
    candidatesFound,
    files,
    durationMs: performance.now() - start,
  };
}
