/**
 * Adjudication tests — the model-facing seam.
 *
 * `parseAdjudicationResponse` is the guarantee layer: no matter what a
 * model actually replies with, the fields on a returned `Finding` must
 * hold the platform's invariants (a "confirmed" verdict always backs
 * itself with a concrete scenario and enough confidence; unknown enum
 * values fail toward the quiet default, never an amplified one). These
 * tests hold the parser to that regardless of how well-formed the input
 * looks — the point is to break the wire format visible and prove the
 * parser doesn't propagate the damage.
 */

import { describe, expect, test } from "bun:test";
import {
  ADJUDICATION_SYSTEM_PROMPT,
  batchCandidates,
  buildAdjudicationPrompt,
  parseAdjudicationResponse,
} from "./adjudication.js";
import { CONFIDENCE_FLOOR } from "./types.js";
import type { Candidate } from "./types.js";

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    vulnSlug: "auth-bypass",
    lineNumbers: [10],
    snippet: "if (skipAuth) return next();",
    matchedPattern: "identifier names an auth skip",
    noiseTier: "normal",
    ...overrides,
  };
}

function goodEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vulnSlug: "auth-bypass",
    lineNumbers: [10],
    verdict: "confirmed",
    severity: "high",
    summary: "Auth is skipped when skipAuth is true.",
    rationale: "The guard reads a hardcoded skipAuth flag with no environment check.",
    failureScenario: "skipAuth is true in production config, so every request bypasses auth.",
    confidence: 0.9,
    ...overrides,
  };
}

describe("parseAdjudicationResponse", () => {
  test("parses a clean JSON array", () => {
    const candidates = [makeCandidate()];
    const raw = JSON.stringify([goodEntry()]);

    const { findings, errors } = parseAdjudicationResponse({ raw, filePath: "src/auth.ts", candidates });

    expect(errors).toEqual([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      vulnSlug: "auth-bypass",
      filePath: "src/auth.ts",
      lineNumbers: [10],
      verdict: "confirmed",
      severity: "high",
      failureScenario: goodEntry().failureScenario,
    });
  });

  test("parses JSON wrapped in a ```json fence", () => {
    const candidates = [makeCandidate()];
    const raw = ["```json", JSON.stringify([goodEntry()]), "```"].join("\n");

    const { findings, errors } = parseAdjudicationResponse({ raw, filePath: "src/auth.ts", candidates });

    expect(errors).toEqual([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.vulnSlug).toBe("auth-bypass");
  });

  test("parses JSON with prose before and after the array", () => {
    const candidates = [makeCandidate()];
    const raw = [
      "Sure, here is my adjudication of the candidate:",
      JSON.stringify([goodEntry()]),
      "Let me know if you need anything else.",
    ].join("\n");

    const { findings, errors } = parseAdjudicationResponse({ raw, filePath: "src/auth.ts", candidates });

    expect(errors).toEqual([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.vulnSlug).toBe("auth-bypass");
  });

  test("a malformed entry lands in errors while good entries still return", () => {
    const candidates = [makeCandidate({ vulnSlug: "auth-bypass" }), makeCandidate({ vulnSlug: "xss", lineNumbers: [22] })];
    const raw = JSON.stringify([
      goodEntry({ vulnSlug: "auth-bypass" }),
      // Malformed: rationale is missing entirely.
      goodEntry({ vulnSlug: "xss", lineNumbers: [22], rationale: undefined }),
    ]);

    const { findings, errors } = parseAdjudicationResponse({ raw, filePath: "src/mixed.ts", candidates });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.vulnSlug).toBe("auth-bypass");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("rationale");
  });

  test('"confirmed" with an empty failureScenario downgrades to "needs-context"', () => {
    const candidates = [makeCandidate()];
    const raw = JSON.stringify([goodEntry({ failureScenario: "" })]);

    const { findings, errors } = parseAdjudicationResponse({ raw, filePath: "src/auth.ts", candidates });

    expect(errors).toEqual([]);
    expect(findings[0]?.verdict).toBe("needs-context");
  });

  test('"confirmed" below CONFIDENCE_FLOOR downgrades to "needs-context"', () => {
    const candidates = [makeCandidate()];
    const raw = JSON.stringify([goodEntry({ confidence: CONFIDENCE_FLOOR - 0.1 })]);

    const { findings } = parseAdjudicationResponse({ raw, filePath: "src/auth.ts", candidates });

    expect(findings[0]?.verdict).toBe("needs-context");
  });

  test('a "confirmed" verdict at or above the floor, with a scenario, is left confirmed', () => {
    const candidates = [makeCandidate()];
    const raw = JSON.stringify([goodEntry({ confidence: CONFIDENCE_FLOOR })]);

    const { findings } = parseAdjudicationResponse({ raw, filePath: "src/auth.ts", candidates });

    expect(findings[0]?.verdict).toBe("confirmed");
  });

  test("an unknown severity coerces to the documented default (\"low\")", () => {
    const candidates = [makeCandidate()];
    const raw = JSON.stringify([goodEntry({ severity: "apocalyptic" })]);

    const { findings } = parseAdjudicationResponse({ raw, filePath: "src/auth.ts", candidates });

    expect(findings[0]?.severity).toBe("low");
  });

  test('an unknown verdict coerces to the documented default ("needs-context")', () => {
    const candidates = [makeCandidate()];
    const raw = JSON.stringify([goodEntry({ verdict: "maybe" })]);

    const { findings } = parseAdjudicationResponse({ raw, filePath: "src/auth.ts", candidates });

    expect(findings[0]?.verdict).toBe("needs-context");
  });

  test("confidence above 1 clamps to 1", () => {
    const candidates = [makeCandidate()];
    const raw = JSON.stringify([goodEntry({ confidence: 1.7 })]);

    const { findings } = parseAdjudicationResponse({ raw, filePath: "src/auth.ts", candidates });

    expect(findings[0]?.confidence).toBe(1);
  });

  test("confidence below 0 clamps to 0", () => {
    const candidates = [makeCandidate()];
    const raw = JSON.stringify([goodEntry({ confidence: -0.4, verdict: "false-positive" })]);

    const { findings } = parseAdjudicationResponse({ raw, filePath: "src/auth.ts", candidates });

    expect(findings[0]?.confidence).toBe(0);
  });

  test("a vulnSlug that names no candidate sent for the file is dropped into errors", () => {
    const candidates = [makeCandidate({ vulnSlug: "auth-bypass" })];
    const raw = JSON.stringify([goodEntry({ vulnSlug: "sql-injection" })]);

    const { findings, errors } = parseAdjudicationResponse({ raw, filePath: "src/auth.ts", candidates });

    expect(findings).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("sql-injection");
  });

  test("a reply with no JSON array at all reports an error and no findings", () => {
    const candidates = [makeCandidate()];
    const { findings, errors } = parseAdjudicationResponse({
      raw: "I was unable to review this candidate.",
      filePath: "src/auth.ts",
      candidates,
    });

    expect(findings).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  test("invalid JSON inside array brackets reports an error and no findings", () => {
    const candidates = [makeCandidate()];
    const { findings, errors } = parseAdjudicationResponse({
      raw: "[{ this is not valid json ]",
      filePath: "src/auth.ts",
      candidates,
    });

    expect(findings).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  test("a { findings: [...] } wrapper is accepted alongside a bare array", () => {
    const candidates = [makeCandidate()];
    const raw = JSON.stringify({ findings: [goodEntry()] });

    const { findings, errors } = parseAdjudicationResponse({ raw, filePath: "src/auth.ts", candidates });

    expect(errors).toEqual([]);
    expect(findings).toHaveLength(1);
  });
});

describe("buildAdjudicationPrompt", () => {
  const candidates = [makeCandidate({ lineNumbers: [2] })];
  const fileContent = ["const a = 1;", "if (skipAuth) return next();", "const b = 2;"].join("\n");

  test("includes the project info block when supplied", () => {
    const prompt = buildAdjudicationPrompt({
      filePath: "src/auth.ts",
      fileContent,
      candidates,
      info: "authService.verify() is the only trusted auth primitive on this platform.",
    });

    expect(prompt).toContain("authService.verify() is the only trusted auth primitive on this platform.");
    expect(prompt).toContain("Project context");
  });

  test("omits the project-context section when info is not supplied", () => {
    const prompt = buildAdjudicationPrompt({ filePath: "src/auth.ts", fileContent, candidates });

    expect(prompt).not.toContain("Project context");
  });

  test("omits the project-context section when info is blank", () => {
    const prompt = buildAdjudicationPrompt({ filePath: "src/auth.ts", fileContent, candidates, info: "   " });

    expect(prompt).not.toContain("Project context");
  });

  test("renders the file with a 1-indexed line-number gutter", () => {
    const prompt = buildAdjudicationPrompt({ filePath: "src/auth.ts", fileContent, candidates });

    expect(prompt).toContain("1| const a = 1;");
    expect(prompt).toContain("2| if (skipAuth) return next();");
    expect(prompt).toContain("3| const b = 2;");
    // Never 0-indexed.
    expect(prompt).not.toMatch(/(?:^|\n)\s*0\|/);
  });

  test("names the file path and candidate count", () => {
    const prompt = buildAdjudicationPrompt({ filePath: "src/auth.ts", fileContent, candidates });

    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("1 candidate");
  });
});

describe("ADJUDICATION_SYSTEM_PROMPT", () => {
  test("is non-empty guidance text", () => {
    expect(ADJUDICATION_SYSTEM_PROMPT.trim().length).toBeGreaterThan(0);
  });
});

describe("batchCandidates", () => {
  function fileWith(filePath: string, count: number): { filePath: string; candidates: Candidate[] } {
    return {
      filePath,
      candidates: Array.from({ length: count }, (_, i) => makeCandidate({ lineNumbers: [i + 1] })),
    };
  }

  test("keeps files whole in one batch when they fit under the cap", () => {
    const files = [fileWith("a.ts", 2), fileWith("b.ts", 2)];
    const batches = batchCandidates({ files, maxCandidatesPerBatch: 10 });

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((f) => f.filePath)).toEqual(["a.ts", "b.ts"]);
  });

  test("starts a new batch rather than exceed the cap", () => {
    const files = [fileWith("a.ts", 3), fileWith("b.ts", 3)];
    const batches = batchCandidates({ files, maxCandidatesPerBatch: 4 });

    expect(batches).toHaveLength(2);
    expect(batches[0]?.map((f) => f.filePath)).toEqual(["a.ts"]);
    expect(batches[1]?.map((f) => f.filePath)).toEqual(["b.ts"]);
  });

  test("splits a single file whose own candidate count exceeds the cap", () => {
    const files = [fileWith("huge.ts", 7)];
    const batches = batchCandidates({ files, maxCandidatesPerBatch: 3 });

    expect(batches).toHaveLength(3);
    expect(batches.map((b) => b[0]?.candidates.length)).toEqual([3, 3, 1]);
    expect(batches.every((b) => b.length === 1 && b[0]?.filePath === "huge.ts")).toBe(true);
  });

  test("skips files with zero candidates", () => {
    const files = [fileWith("empty.ts", 0), fileWith("a.ts", 1)];
    const batches = batchCandidates({ files, maxCandidatesPerBatch: 10 });

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((f) => f.filePath)).toEqual(["a.ts"]);
  });
});
