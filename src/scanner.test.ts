/**
 * Scanner tests — the pure core (`scanContent`), no filesystem involved.
 *
 * `scanContent` is the hot loop that will run over every file in a repo,
 * so the properties worth locking down are the ones that are cheap to get
 * subtly wrong: line-number math, the dedupe rule, `filePatterns` gating,
 * snippet sizing, and — the one that bites hardest because it's invisible
 * in a single-file test — that a matcher's shared `RegExp` never carries
 * state (`lastIndex`) from one `scanContent` call into the next.
 */

import { describe, expect, test } from "bun:test";
import { scanContent } from "./scanner.js";
import type { Matcher } from "./types.js";

function makeMatcher(overrides: Partial<Matcher> = {}): Matcher {
  return {
    slug: "test-slug",
    description: "A fixture matcher for scanner tests.",
    noiseTier: "normal",
    filePatterns: ["**/*.ts"],
    patterns: [{ regex: /BAD_TOKEN/, label: "bad token found" }],
    ...overrides,
  };
}

describe("scanContent", () => {
  test("finds a candidate in obviously-bad content and reports correct 1-indexed line numbers", () => {
    const content = ["const a = 1;", "const bad = BAD_TOKEN;", "const c = 3;"].join("\n");

    const candidates = scanContent({ filePath: "src/foo.ts", content, matchers: [makeMatcher()] });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.vulnSlug).toBe("test-slug");
    expect(candidates[0]?.lineNumbers).toEqual([2]);
    expect(candidates[0]?.matchedPattern).toBe("bad token found");
    expect(candidates[0]?.noiseTier).toBe("normal");
  });

  test("returns nothing for clean content", () => {
    const content = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");

    const candidates = scanContent({ filePath: "src/foo.ts", content, matchers: [makeMatcher()] });

    expect(candidates).toEqual([]);
  });

  test("reports the correct line number for a match past the first line, in a larger file", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `const line${i + 1} = ${i + 1};`);
    lines[14] = "const trap = BAD_TOKEN;"; // line 15 (1-indexed)
    const content = lines.join("\n");

    const candidates = scanContent({ filePath: "src/foo.ts", content, matchers: [makeMatcher()] });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.lineNumbers).toEqual([15]);
  });

  test("dedupes: one line hit by two patterns of the same slug yields ONE candidate", () => {
    const matcher = makeMatcher({
      patterns: [
        { regex: /FOO/, label: "short pattern" },
        { regex: /FOOBAR/, label: "long pattern" },
      ],
    });
    const content = "const x = FOOBAR;";

    const candidates = scanContent({ filePath: "src/foo.ts", content, matchers: [matcher] });

    expect(candidates).toHaveLength(1);
    // The longer, more specific match wins the tie-break.
    expect(candidates[0]?.matchedPattern).toBe("long pattern");
  });

  test("does NOT dedupe hits from different slugs on the same line", () => {
    const matcherA = makeMatcher({ slug: "slug-a", patterns: [{ regex: /FOO/, label: "a" }] });
    const matcherB = makeMatcher({ slug: "slug-b", patterns: [{ regex: /BAR/, label: "b" }] });
    const content = "const x = FOO_BAR;";

    const candidates = scanContent({ filePath: "src/foo.ts", content, matchers: [matcherA, matcherB] });

    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.vulnSlug).sort()).toEqual(["slug-a", "slug-b"]);
  });

  test("respects filePatterns — a .svelte-only matcher must not fire on a .ts path", () => {
    const svelteOnly = makeMatcher({ filePatterns: ["**/*.svelte"] });
    const content = "const bad = BAD_TOKEN;";

    const onTs = scanContent({ filePath: "src/foo.ts", content, matchers: [svelteOnly] });
    const onSvelte = scanContent({ filePath: "src/foo.svelte", content, matchers: [svelteOnly] });

    expect(onTs).toEqual([]);
    expect(onSvelte).toHaveLength(1);
  });

  test("a file matching no matcher's filePatterns is scanned with zero matchers applied", () => {
    const tsOnly = makeMatcher({ filePatterns: ["**/*.ts"] });
    const content = "const bad = BAD_TOKEN;";

    const candidates = scanContent({ filePath: "src/foo.py", content, matchers: [tsOnly] });

    expect(candidates).toEqual([]);
  });

  test("snippet includes surrounding context beyond just the matched line", () => {
    const lines = Array.from({ length: 11 }, (_, i) => `line${i + 1}`);
    lines[5] = "line6 BAD_TOKEN"; // match on line 6, out of 11
    const content = lines.join("\n");

    const candidates = scanContent({ filePath: "src/foo.ts", content, matchers: [makeMatcher()] });

    expect(candidates).toHaveLength(1);
    const snippet = candidates[0]?.snippet ?? "";
    // Context from nearby lines is present...
    expect(snippet).toContain("line5");
    expect(snippet).toContain("line6 BAD_TOKEN");
    expect(snippet).toContain("line7");
    // ...but the snippet is a WINDOW, not the whole file.
    expect(snippet).not.toContain("line1\n");
    expect(snippet).not.toContain("line11");
  });

  test("snippet is length-capped rather than growing unbounded with long context lines", () => {
    // Five ~500-char lines of context around the match is well past any
    // reasonable single-candidate payload; the raw (uncapped) join would
    // run into the thousands of characters.
    const longLine = (label: string): string => `${label}_${"x".repeat(480)}`;
    const lines = [
      longLine("l1"),
      longLine("l2"),
      `${longLine("l3")}_BAD_TOKEN`,
      longLine("l4"),
      longLine("l5"),
    ];
    const content = lines.join("\n");
    const rawContextLength = lines.join("\n").length;

    const candidates = scanContent({ filePath: "src/foo.ts", content, matchers: [makeMatcher()] });

    expect(candidates).toHaveLength(1);
    const snippet = candidates[0]?.snippet ?? "";
    expect(snippet.length).toBeLessThan(rawContextLength);
    // A truncated snippet is marked as such rather than silently cut.
    expect(snippet.endsWith("…")).toBe(true);
  });

  test("REGRESSION: scanning the same content twice returns identical results (no shared regex lastIndex leak)", () => {
    const matcher = makeMatcher({ patterns: [{ regex: /BAD_TOKEN/, label: "bad token found" }] });
    const content = [
      "const a = BAD_TOKEN;",
      "const b = 2;",
      "const c = BAD_TOKEN;",
      "const d = 4;",
      "const e = BAD_TOKEN;",
    ].join("\n");

    // Warm up the SAME matcher (and therefore the same underlying
    // `pattern.regex` object) against a prior "file" first, simulating a
    // multi-file scan — this is exactly the scenario the header comment in
    // scanner.ts calls out as the trap.
    scanContent({ filePath: "src/other.ts", content, matchers: [matcher] });

    const first = scanContent({ filePath: "src/foo.ts", content, matchers: [matcher] });
    const second = scanContent({ filePath: "src/foo.ts", content, matchers: [matcher] });
    const third = scanContent({ filePath: "src/foo.ts", content, matchers: [matcher] });

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});
