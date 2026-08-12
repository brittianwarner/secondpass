/**
 * Matcher hygiene tests — every regex family the scan stage runs.
 *
 * These are NOT tests of individual matcher intent (that would be
 * over-fitting to today's pattern set). They are the invariants every
 * matcher must hold — the default set and any pack you add — so the scan
 * stage stays fast, deterministic, and re-runnable:
 *
 *   - unique, well-formed metadata (slug/description/noiseTier/patterns)
 *   - no catastrophic backtracking on adversarial input
 *   - no shared `g` flag (silently eats matches via `lastIndex`)
 *   - each matcher's own examples actually exercise its own patterns
 */

import { describe, expect, test } from "bun:test";
import { ALL_MATCHERS } from "./index.js";
import type { Matcher, NoiseTier } from "../types.js";

const VALID_NOISE_TIERS: readonly NoiseTier[] = ["low", "normal", "high"];

/**
 * A ~5 KB pathological input built from the substrings that most commonly
 * trigger catastrophic backtracking in hand-written regexes: long runs of
 * whitespace, unbalanced quotes/braces, and template-literal openers with
 * no matching close. A regex with nested quantifiers or ambiguous
 * alternation over these classes goes exponential; a well-formed one
 * (bounded quantifiers, anchored classes) finishes instantly regardless
 * of input length.
 */
const PATHOLOGICAL_INPUT = [
  " ".repeat(1200),
  '"'.repeat(600),
  "'".repeat(600),
  "`".repeat(400),
  "{".repeat(500),
  "}".repeat(500),
  "${".repeat(500), // 1000 chars of unterminated template interpolation
  "[".repeat(200),
  "]".repeat(200),
].join("");

// Catastrophic backtracking blows this up by orders of magnitude (seconds,
// not milliseconds), so this ceiling has generous headroom above a normal
// bounded-regex pass on 5 KB while still catching a real ReDoS.
const MAX_REGEX_MS = 100;

function allPatterns(matcher: Matcher): Array<{ matcher: Matcher; regex: RegExp; label: string }> {
  return matcher.patterns.map((p) => ({ matcher, regex: p.regex, label: p.label }));
}

describe("ALL_MATCHERS registry", () => {
  test("is non-empty", () => {
    expect(ALL_MATCHERS.length).toBeGreaterThan(0);
  });

  test("every matcher has a unique slug", () => {
    const slugs = ALL_MATCHERS.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test("every slug is stable kebab-case", () => {
    for (const matcher of ALL_MATCHERS) {
      expect(matcher.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  test("every matcher has a non-empty description", () => {
    for (const matcher of ALL_MATCHERS) {
      expect(matcher.description.trim().length).toBeGreaterThan(0);
    }
  });

  test("every matcher declares at least one pattern", () => {
    for (const matcher of ALL_MATCHERS) {
      expect(matcher.patterns.length).toBeGreaterThan(0);
    }
  });

  test("every matcher declares at least one file pattern", () => {
    for (const matcher of ALL_MATCHERS) {
      expect(matcher.filePatterns.length).toBeGreaterThan(0);
    }
  });

  test("every matcher has a valid noiseTier", () => {
    for (const matcher of ALL_MATCHERS) {
      expect(VALID_NOISE_TIERS).toContain(matcher.noiseTier);
    }
  });

  test("every pattern label is non-empty", () => {
    for (const matcher of ALL_MATCHERS) {
      for (const pattern of matcher.patterns) {
        expect(pattern.label.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("regex safety", () => {
  const entries = ALL_MATCHERS.flatMap(allPatterns);

  test("every regex is a compiled RegExp instance", () => {
    for (const { regex } of entries) {
      expect(regex).toBeInstanceOf(RegExp);
      expect(regex.source.length).toBeGreaterThan(0);
    }
  });

  test("no regex carries the global flag (shared `g` regexes leak lastIndex across calls)", () => {
    for (const { matcher, regex, label } of entries) {
      expect(regex.flags, `${matcher.slug} / "${label}" (/${regex.source}/${regex.flags})`).not.toContain(
        "g",
      );
    }
  });

  test("no regex hangs on a 5 KB pathological input (ReDoS guard)", () => {
    for (const { matcher, regex, label } of entries) {
      const start = performance.now();
      regex.test(PATHOLOGICAL_INPUT);
      const elapsed = performance.now() - start;
      expect(
        elapsed,
        `${matcher.slug} / "${label}" (/${regex.source}/${regex.flags}) took ${elapsed.toFixed(1)}ms`,
      ).toBeLessThan(MAX_REGEX_MS);
    }
  });

  test("repeated evaluation against the same input is stable (no stateful lastIndex drift)", () => {
    for (const { regex } of entries) {
      const first = regex.test(PATHOLOGICAL_INPUT);
      const second = regex.test(PATHOLOGICAL_INPUT);
      const third = regex.test(PATHOLOGICAL_INPUT);
      expect(second).toBe(first);
      expect(third).toBe(first);
    }
  });
});

describe("matcher examples exercise their own patterns", () => {
  for (const matcher of ALL_MATCHERS) {
    if (!matcher.examples || matcher.examples.length === 0) continue;

    test(`${matcher.slug}: every documented example matches at least one of its own patterns`, () => {
      for (const example of matcher.examples ?? []) {
        const hit = matcher.patterns.some(({ regex }) => regex.test(example));
        expect(hit, `example did not match any "${matcher.slug}" pattern: ${example}`).toBe(true);
      }
    });
  }
});
