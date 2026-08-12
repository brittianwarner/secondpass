/**
 * CLI tests.
 *
 * The bar here is behavioural, not incidental: these check the promises the
 * README makes to a developer — that one API key is enough, that the
 * variable name is the only thing that ever leaves the credential module,
 * that an unanswered INFO.md is not injected into a prompt, and that a
 * run record survives a round trip.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findConfigFile, loadConfig, readInfoFile, resolveProject } from "./config.js";
import {
  SUPPORTED_API_KEY_ENVS,
  loadEnvFiles,
  parseEnvFile,
  resolveCredential,
} from "./credential.js";
import { flagBool, flagNumber, flagString, parseArgv } from "./index.js";
import { renderRunConsole, renderRunMarkdown, sortFindings } from "./render.js";
import { listRuns, loadRun, newRunId, saveRun, type StoredRun } from "./store.js";
import type { Finding } from "../types.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "secondpass-cli-"));
  tempDirs.push(dir);
  return dir;
}

/** Every test that touches process.env registers its cleanup here. */
const envRestores: Array<() => void> = [];
function setEnv(name: string, value: string | undefined): void {
  const previous = process.env[name];
  envRestores.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Clear every supported credential so a test starts from a known-empty state. */
function clearAllCredentials(): void {
  for (const name of SUPPORTED_API_KEY_ENVS) setEnv(name, undefined);
}

afterEach(() => {
  while (envRestores.length > 0) envRestores.pop()?.();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseArgv", () => {
  test("splits command, positionals, and both flag spellings", () => {
    const args = parseArgv(["scan", "./src", "--model", "m1", "--json", "--concurrency=4"]);
    expect(args.command).toBe("scan");
    expect(args.positionals).toEqual(["./src"]);
    expect(flagString(args, "model")).toBe("m1");
    expect(flagBool(args, "json")).toBe(true);
    expect(flagNumber(args, "concurrency")).toBe(4);
  });

  test("a boolean flag followed by another flag does not swallow it", () => {
    const args = parseArgv(["scan", "--scan-only", "--all"]);
    expect(flagBool(args, "scan-only")).toBe(true);
    expect(flagBool(args, "all")).toBe(true);
    expect(flagString(args, "scan-only")).toBeUndefined();
  });

  test("a non-numeric value for a numeric flag reads as absent, not NaN", () => {
    expect(flagNumber(parseArgv(["scan", "--concurrency", "lots"]), "concurrency")).toBeUndefined();
  });
});

describe("parseEnvFile", () => {
  test("handles export prefixes, quotes, comments, and blank lines", () => {
    const parsed = parseEnvFile(
      [
        "# a comment",
        "",
        "export ANTHROPIC_API_KEY=sk-plain",
        `OPENAI_API_KEY="sk-quoted"`,
        "GROQ_API_KEY='sk-single'",
        "XAI_API_KEY=sk-trailing # inline comment",
        "NOT A KEY",
        "EMPTY=",
      ].join("\n"),
    );
    expect(parsed.get("ANTHROPIC_API_KEY")).toBe("sk-plain");
    expect(parsed.get("OPENAI_API_KEY")).toBe("sk-quoted");
    expect(parsed.get("GROQ_API_KEY")).toBe("sk-single");
    expect(parsed.get("XAI_API_KEY")).toBe("sk-trailing");
    expect(parsed.has("EMPTY")).toBe(false);
  });

  test("a # inside a quoted value is part of the value", () => {
    expect(parseEnvFile(`ANTHROPIC_API_KEY="sk-a#b"`).get("ANTHROPIC_API_KEY")).toBe("sk-a#b");
  });
});

describe("loadEnvFiles", () => {
  test("an exported variable beats a file", () => {
    clearAllCredentials();
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=from-file\n");
    setEnv("ANTHROPIC_API_KEY", "from-shell");

    loadEnvFiles({ dirs: [dir] });
    expect(process.env.ANTHROPIC_API_KEY).toBe("from-shell");
  });

  test("a file fills in a variable that is not set", () => {
    clearAllCredentials();
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "GROQ_API_KEY=from-file\n");

    const read = loadEnvFiles({ dirs: [dir] });
    expect(process.env.GROQ_API_KEY).toBe("from-file");
    expect(read).toEqual([join(dir, ".env")]);
  });

  test(".env.local wins over .env in the same directory", () => {
    clearAllCredentials();
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "MISTRAL_API_KEY=from-env\n");
    writeFileSync(join(dir, ".env.local"), "MISTRAL_API_KEY=from-local\n");

    loadEnvFiles({ dirs: [dir] });
    expect(process.env.MISTRAL_API_KEY).toBe("from-local");
  });
});

describe("resolveCredential", () => {
  test("picks the first supported variable that is set", () => {
    clearAllCredentials();
    setEnv("OPENAI_API_KEY", "sk-openai");
    setEnv("ANTHROPIC_API_KEY", "sk-anthropic");

    const lookup = resolveCredential({});
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.resolution.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect(lookup.resolution.alsoAvailable).toEqual(["OPENAI_API_KEY"]);
  });

  test("names the variable the developer asked for when it is unset", () => {
    clearAllCredentials();
    setEnv("ANTHROPIC_API_KEY", "sk-anthropic");

    const lookup = resolveCredential({ explicit: "OPENAI_API_KEY" });
    expect(lookup.ok).toBe(false);
    if (lookup.ok) return;
    expect(lookup.error).toContain("OPENAI_API_KEY");
  });

  test("rejects a variable no provider is known for", () => {
    clearAllCredentials();
    setEnv("MY_OWN_KEY", "sk-whatever");

    const lookup = resolveCredential({ explicit: "MY_OWN_KEY" });
    expect(lookup.ok).toBe(false);
    if (lookup.ok) return;
    expect(lookup.error).toContain("does not know which provider");
  });

  test("with nothing set, the error lists what to export", () => {
    clearAllCredentials();
    const lookup = resolveCredential({});
    expect(lookup.ok).toBe(false);
    if (lookup.ok) return;
    expect(lookup.error).toContain("export ANTHROPIC_API_KEY");
    expect(lookup.searched).toEqual([...SUPPORTED_API_KEY_ENVS]);
  });

  test("never returns the credential value, only its name", () => {
    clearAllCredentials();
    const secret = "sk-do-not-leak-this-anywhere";
    setEnv("ANTHROPIC_API_KEY", secret);

    const lookup = resolveCredential({});
    expect(JSON.stringify(lookup)).not.toContain(secret);
  });
});

describe("readInfoFile", () => {
  test("an unanswered scaffold is not injected", () => {
    const dir = tempDir();
    const path = join(dir, "INFO.md");
    writeFileSync(
      path,
      [
        "# demo — context for security review",
        "",
        "## What is the trust boundary?",
        "",
        "<!-- Where does untrusted input enter? Which function is the gate? -->",
        "",
        "## What looks dangerous but is fine?",
        "",
        "<!-- Name the patterns that will keep getting flagged. -->",
      ].join("\n"),
    );
    expect(readInfoFile(path)).toEqual({ state: "template", path });
  });

  test("one answered question makes it real, and comments are stripped", () => {
    const dir = tempDir();
    const path = join(dir, "INFO.md");
    writeFileSync(
      path,
      [
        "# demo",
        "",
        "## What is the trust boundary?",
        "",
        "<!-- a prompt nobody should pay tokens for -->",
        "Every route under src/routes.ts is public.",
      ].join("\n"),
    );
    const info = readInfoFile(path);
    expect(info.state).toBe("filled");
    expect(info.text).toContain("Every route under src/routes.ts is public.");
    expect(info.text).not.toContain("a prompt nobody should pay tokens for");
  });

  test("a missing file is absent, not an error", () => {
    expect(readInfoFile(join(tempDir(), "nope.md")).state).toBe("absent");
  });
});

describe("loadConfig", () => {
  test("a bare directory yields a project without a config file", () => {
    const dir = tempDir();
    const loaded = loadConfig({ cwd: dir });
    expect(loaded.configPath).toBeNull();
    expect(loaded.config.projects).toHaveLength(1);
    expect(loaded.config.projects[0]?.root).toBe(dir);
  });

  test("an explicit root wins over a config found by walking up", () => {
    const root = tempDir();
    writeFileSync(
      join(root, "secondpass.config.json"),
      JSON.stringify({ projects: [{ id: "configured", root: "." }] }),
    );
    const nested = join(root, "nested");
    mkdirSync(nested);

    const loaded = loadConfig({ cwd: root, explicitRoot: nested });
    expect(loaded.configPath).toBeNull();
    expect(loaded.config.projects[0]?.root).toBe(nested);
  });

  test("finds a config in a parent directory", () => {
    const root = tempDir();
    writeFileSync(
      join(root, "secondpass.config.json"),
      JSON.stringify({ projects: [{ id: "app", root: "." }] }),
    );
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findConfigFile(nested)).toBe(join(root, "secondpass.config.json"));
  });

  test("rejects a config with a duplicate project id", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "secondpass.config.json"),
      JSON.stringify({ projects: [{ id: "x", root: "." }, { id: "x", root: "./other" }] }),
    );
    expect(() => loadConfig({ cwd: dir })).toThrow(/duplicate project id/);
  });

  test("rejects a config that is not valid JSON", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "secondpass.config.json"), "{ projects: [ }");
    expect(() => loadConfig({ cwd: dir })).toThrow(/not valid JSON/);
  });

  test("resolveProject turns relative paths absolute and loads real context", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "CONTEXT.md"), "# ctx\n\nThe auth gate is requireOrg().\n");
    const project = resolveProject({
      entry: { id: "app", root: "src", info: "CONTEXT.md" },
      baseDir: dir,
    });
    expect(project.root).toBe(join(dir, "src"));
    expect(project.info).toContain("requireOrg()");
  });
});

const FINDING = (over: Partial<Finding> = {}): Finding => ({
  filePath: "src/db.ts",
  vulnSlug: "sql-injection",
  lineNumbers: [7],
  verdict: "confirmed",
  severity: "critical",
  confidence: 0.95,
  summary: "User input interpolated into SQL.",
  rationale: "Line 7 concatenates req.params into the query.",
  failureScenario: "An attacker passes ' OR '1'='1 and reads every row.",
  ...over,
});

const RUN = (over: Partial<StoredRun> = {}): StoredRun => ({
  version: 1,
  runId: newRunId(),
  projectId: "demo",
  rootPath: "/tmp/demo",
  startedAt: "2026-08-12T04:00:00.000Z",
  completedAt: "2026-08-12T04:00:30.000Z",
  adjudicated: true,
  scan: { filesScanned: 3, filesWithCandidates: 2, candidatesFound: 4, durationMs: 12 },
  files: [],
  findings: [FINDING()],
  errors: [],
  durationMs: 30_000,
  invocation: {
    command: "secondpass scan",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    model: null,
    matcherPacks: ["default"],
    adjudicated: true,
  },
  ...over,
});

describe("store", () => {
  test("a run survives a save/load round trip", () => {
    const dir = tempDir();
    const run = RUN();
    saveRun({ baseDir: dir, run });

    const loaded = loadRun({ baseDir: dir });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.run).toEqual(run);
  });

  test("a run id prefix is enough", () => {
    const dir = tempDir();
    const run = RUN();
    saveRun({ baseDir: dir, run });

    const loaded = loadRun({ baseDir: dir, runId: run.runId.slice(0, 8) });
    expect(loaded.ok).toBe(true);
  });

  test("an ambiguous prefix is an error naming the candidates, not a guess", () => {
    const dir = tempDir();
    const a = RUN({ runId: "20260812T040000-aaaaaaaa" });
    const b = RUN({ runId: "20260812T040001-bbbbbbbb" });
    saveRun({ baseDir: dir, run: a });
    saveRun({ baseDir: dir, run: b });

    const loaded = loadRun({ baseDir: dir, runId: "2026" });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain(a.runId);
    expect(loaded.error).toContain(b.runId);
  });

  test("listRuns orders newest first and tallies verdicts", () => {
    const dir = tempDir();
    saveRun({ baseDir: dir, run: RUN({ runId: "20260812T040000-aaaaaaaa" }) });
    saveRun({
      baseDir: dir,
      run: RUN({
        runId: "20260812T050000-bbbbbbbb",
        findings: [FINDING(), FINDING({ verdict: "false-positive" })],
      }),
    });

    const rows = listRuns({ baseDir: dir });
    expect(rows.map((r) => r.runId)).toEqual([
      "20260812T050000-bbbbbbbb",
      "20260812T040000-aaaaaaaa",
    ]);
    expect(rows[0]?.confirmed).toBe(1);
    expect(rows[0]?.falsePositive).toBe(1);
  });

  test("no runs is a message, not a crash", () => {
    const loaded = loadRun({ baseDir: tempDir() });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain("secondpass scan");
  });

  test("newRunId sorts lexically by time", () => {
    const earlier = newRunId(new Date("2026-08-12T04:00:00Z"));
    const later = newRunId(new Date("2026-08-12T05:00:00Z"));
    expect(earlier < later).toBe(true);
  });
});

describe("render", () => {
  test("confirmed findings sort ahead of ruled-out ones, worst first", () => {
    const sorted = sortFindings([
      FINDING({ verdict: "false-positive", severity: "critical" }),
      FINDING({ verdict: "confirmed", severity: "low" }),
      FINDING({ verdict: "confirmed", severity: "critical" }),
      FINDING({ verdict: "needs-context", severity: "high" }),
    ]);
    expect(sorted.map((f) => `${f.verdict}/${f.severity}`)).toEqual([
      "confirmed/critical",
      "confirmed/low",
      "needs-context/high",
      "false-positive/critical",
    ]);
  });

  test("ruled-out findings are hidden until --all", () => {
    const run = RUN({ findings: [FINDING({ verdict: "false-positive" })] });
    const hidden = renderRunConsole(run, { color: false });
    expect(hidden).toContain("Nothing confirmed");
    expect(hidden).not.toContain("User input interpolated into SQL.");
    expect(renderRunConsole(run, { color: false, all: true })).toContain(
      "User input interpolated into SQL.",
    );
  });

  test("a run that returned no verdicts does not read as a clean bill of health", () => {
    // The failure this guards: a bad credential makes every call return an
    // error body, which parses to zero findings. Rendered as "Nothing
    // confirmed", that announces a pass for work that never happened.
    const run = RUN({ findings: [], adjudication: { prompts: 2, answered: 0 } });
    const out = renderRunConsole(run, { color: false });
    expect(out).toContain("No verdicts returned");
    expect(out).toContain("makes no claim");
    expect(out).not.toContain("Nothing confirmed");
    expect(out).not.toContain("All 0 candidate(s) were ruled out");
  });

  test("nothing confirmed still reads clean when adjudication actually ruled candidates out", () => {
    const run = RUN({
      findings: [FINDING({ verdict: "false-positive" })],
      adjudication: { prompts: 1, answered: 1 },
    });
    const out = renderRunConsole(run, { color: false });
    expect(out).toContain("Nothing confirmed");
    expect(out).toContain("All 1 candidate(s) were ruled out");
  });

  test("each verdict renders under its own tag — a ruled-out finding never reads as open", () => {
    const run = RUN({
      findings: [
        FINDING({ verdict: "confirmed", severity: "critical", summary: "Confirmed one." }),
        FINDING({ verdict: "needs-context", summary: "Open question." }),
        FINDING({ verdict: "false-positive", summary: "Closed by adjudication." }),
      ],
    });
    const out = renderRunConsole(run, { color: false, all: true });
    expect(out).toContain("1 confirmed · 1 needs context · 1 ruled out");
    expect(out).toContain("CRITICAL");
    expect(out).toContain("NEEDS CONTEXT");
    expect(out).toContain("RULED OUT");
    // The tally and the entries must agree: exactly one of each, not two
    // "needs context" entries under a tally that claims one.
    expect(out.split("NEEDS CONTEXT").length - 1).toBe(1);
  });

  test("errors are surfaced, never swallowed", () => {
    const run = RUN({ errors: ["adjudication failed for src/a.ts: timeout"] });
    expect(renderRunConsole(run, { color: false })).toContain("1 error(s)");
    expect(renderRunMarkdown(run)).toContain("adjudication failed for src/a.ts");
  });

  test("a scan-only run reports candidates, and never calls them findings", () => {
    const run = RUN({
      adjudicated: false,
      findings: [],
      files: [
        {
          filePath: "src/db.ts",
          fileHash: "deadbeef",
          candidates: [
            {
              vulnSlug: "sql-injection",
              lineNumbers: [7],
              matchedPattern: "template literal in query()",
              snippet: "pool.query(`...${email}...`)",
              noiseTier: "normal",
            },
          ],
        },
      ],
    });
    const markdown = renderRunMarkdown(run);
    expect(markdown).toContain("**candidate**");
    expect(markdown).toContain("`src/db.ts:7`");
    expect(markdown).not.toContain("| confirmed |");
  });

  test("NO_COLOR suppresses escape codes", () => {
    expect(renderRunConsole(RUN(), { color: false })).not.toContain("[");
  });
});
