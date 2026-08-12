/**
 * `secondpass scan` — the command the whole package exists for.
 *
 * Free deterministic pass, then a costed model pass over what it found. The
 * only thing a developer has to supply is one API key, and if that key is
 * missing this command says so in one line and names the variable, rather
 * than failing somewhere inside a sandbox six steps later.
 *
 * Exit codes, because this belongs in CI:
 *   0  no confirmed finding at or above the threshold
 *   1  confirmed findings at or above --fail-on (default: high)
 *   2  the scan could not run, or could not run far enough to make a claim
 */

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { runScan, type RunEvent } from "../../pipeline.js";
import { ALL_MATCHERS } from "../../matchers/index.js";
import type { Severity } from "../../types.js";
import { buildContext, selectProject } from "../context.js";
import type { ParsedArgs } from "../index.js";
import { flagBool, flagNumber, flagString } from "../index.js";
import { makePainter, renderRunConsole, renderRunMarkdown, shouldUseColor } from "../render.js";
import { newRunId, saveRun, type StoredRun } from "../store.js";

const HELP = `secondpass scan — scan a project and adjudicate what it finds

Usage
  secondpass scan [dir] [options]

Options
  --project <id>          Project from the config (required if it has several)
  --scan-only             Stop after the free deterministic pass. Costs nothing.
  --all                   Show ruled-out candidates too
  --out <file.md>         Also write a Markdown report
  --json                  Print the run record as JSON instead of a report
  --quiet                 Suppress progress; print the report only

  --api-key-env <NAME>    Env var holding the model credential (auto-detected)
  --model <id>            Model id (provider default when omitted)
  --concurrency <n>       Adjudications in flight. Default 2; each costs a
                          sandbox process, and measured gains flatten fast.
  --timeout <ms>          Per-adjudication timeout. Default 120000.
  --max-candidates <n>    Candidates per prompt before a file is split. Default 20.

  --fail-on <level>       critical | high | medium | low | any | never
                          Exit 1 when a confirmed finding reaches this
                          severity. Default: high.
`;

const SEVERITY_LADDER: readonly Severity[] = ["low", "medium", "high", "critical"];

/** Every value `--fail-on` accepts. Anything else is a typo, not a threshold. */
export const FAIL_ON_VALUES: readonly string[] = [...SEVERITY_LADDER, "any", "never"];

/**
 * Accept a `--fail-on` value or say why not.
 *
 * Unknown values must be rejected rather than defaulted: a threshold nobody
 * recognizes used to match nothing, so `--fail-on hgih` in a CI config
 * disabled the gate and every run passed.
 */
export function resolveThreshold(
  input: string | undefined,
): { ok: true; threshold: string } | { ok: false; error: string } {
  const threshold = input ?? "high";
  if (!FAIL_ON_VALUES.includes(threshold)) {
    return {
      ok: false,
      error: `Unknown --fail-on value: ${threshold}. Expected one of: ${FAIL_ON_VALUES.join(", ")}.`,
    };
  }
  return { ok: true, threshold };
}

/**
 * Meets or exceeds the threshold. `any` catches everything, `never` nothing.
 *
 * Only ever called with a threshold that `FAIL_ON_VALUES` already accepted —
 * an unrecognized one used to fall through to `false`, which turned a typo in
 * a CI config (`--fail-on hgih`) into a scanner that passes everything.
 */
function failsThreshold(severity: Severity, threshold: string): boolean {
  if (threshold === "never") return false;
  if (threshold === "any") return true;
  const want = SEVERITY_LADDER.indexOf(threshold as Severity);
  if (want === -1) return false;
  return SEVERITY_LADDER.indexOf(severity) >= want;
}

export async function runScanCommand(args: ParsedArgs): Promise<number> {
  if (flagBool(args, "help")) {
    console.log(HELP);
    return 0;
  }

  const paint = makePainter({ color: shouldUseColor() });
  const quiet = flagBool(args, "quiet") || flagBool(args, "json");
  const note = (line: string): void => {
    if (!quiet) console.log(line);
  };

  const ctx = buildContext(args, args.positionals[0]);
  const selected = selectProject(ctx, flagString(args, "project"));
  if (!selected.ok) {
    console.error(selected.error);
    return 2;
  }
  const { project } = selected.selected;

  // Check the target before the walk reaches it. Left to the file walker, a
  // typo'd path surfaces as an unhandled ENOENT stack trace on exit 1 — the
  // same code as "confirmed findings", so CI cannot tell a misspelled
  // directory from a critical vulnerability.
  const rootStat = ((): { ok: true } | { ok: false; error: string } => {
    try {
      if (!statSync(project.root).isDirectory()) {
        return { ok: false, error: `not a directory: ${project.root}` };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: `no such directory: ${project.root}` };
    }
  })();
  if (!rootStat.ok) {
    console.error("");
    console.error(`  ${paint("red", "Cannot scan.")} ${rootStat.error}`);
    console.error("");
    return 2;
  }

  const adjudicate = !flagBool(args, "scan-only");
  if (adjudicate && !ctx.credential.ok) {
    console.error("");
    console.error(`  ${paint("red", "No model credential.")} ${ctx.credential.error}`);
    console.error("");
    console.error(`  Or run the free pass only:  ${paint("bold", "secondpass scan --scan-only")}`);
    console.error("");
    return 2;
  }

  const resolvedThreshold = resolveThreshold(flagString(args, "fail-on"));
  if (!resolvedThreshold.ok) {
    console.error("");
    console.error(`  ${paint("red", resolvedThreshold.error)}`);
    console.error("");
    return 2;
  }
  const { threshold } = resolvedThreshold;
  const runId = newRunId();

  note("");
  note(
    `${paint("bold", "secondpass")} ${paint("dim", `${project.id} · ${project.root}`)}`,
  );
  if (adjudicate && ctx.credential.ok) {
    const { resolution } = ctx.credential;
    note(
      paint(
        "dim",
        `  using $${resolution.apiKeyEnv} (${resolution.source})${ctx.model ? ` · model ${ctx.model}` : ""}`,
      ),
    );
  } else if (!adjudicate) {
    note(paint("dim", "  --scan-only: the deterministic pass only, no model calls"));
  }
  note("");

  const progress = makeProgressReporter({ quiet, paint });
  const onEvent = (event: RunEvent): void => {
    progress(event);
  };

  const result = await runScan({
    project,
    runId,
    matchers: ALL_MATCHERS,
    adjudicate,
    ...(flagNumber(args, "max-candidates") === undefined
      ? {}
      : { maxCandidatesPerBatch: flagNumber(args, "max-candidates") as number }),
    sandbox: {
      ...(ctx.credential.ok ? { apiKeyEnv: ctx.credential.resolution.apiKeyEnv } : {}),
      ...(ctx.model === undefined ? {} : { model: ctx.model }),
      ...(flagNumber(args, "concurrency") === undefined
        ? {}
        : { concurrency: flagNumber(args, "concurrency") as number }),
      ...(flagNumber(args, "timeout") === undefined
        ? {}
        : { timeoutMs: flagNumber(args, "timeout") as number }),
    },
    onEvent,
  });

  const stored: StoredRun = {
    ...result,
    version: 1,
    invocation: {
      command: `secondpass ${["scan", ...args.positionals, ...formatFlags(args)].join(" ")}`.trim(),
      // Only record a credential the run actually spent. A --scan-only run
      // that reports "credential: $ANTHROPIC_API_KEY" is claiming a model
      // looked at this code when none did.
      apiKeyEnv: adjudicate && ctx.credential.ok ? ctx.credential.resolution.apiKeyEnv : null,
      model: adjudicate ? (ctx.model ?? null) : null,
      matcherPacks: ["default"],
      adjudicated: result.adjudicated,
    },
  };

  // Save before rendering. A run that cost real money must survive a crash
  // in the renderer.
  let savedPath: string | null = null;
  try {
    savedPath = saveRun({ baseDir: ctx.loaded.baseDir, run: stored });
  } catch (err) {
    console.error(
      paint("yellow", `  could not save the run record: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  if (flagBool(args, "json")) {
    console.log(JSON.stringify(stored, null, 2));
  } else {
    console.log(renderRunConsole(stored, { all: flagBool(args, "all") }));
    if (savedPath) console.log(paint("dim", `  saved  ${savedPath}`));
  }

  const outPath = flagString(args, "out");
  if (outPath) {
    try {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, renderRunMarkdown(stored, { all: flagBool(args, "all") }), "utf8");
      if (!flagBool(args, "json")) console.log(paint("dim", `  report ${outPath}`));
    } catch (err) {
      console.error(`could not write ${outPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!flagBool(args, "json")) console.log("");

  // A run where every adjudication failed has not found "nothing" — it has
  // found out nothing. Reporting that as a pass would be a lie the exit code
  // tells to a CI system that cannot check. Measured on verdicts returned, not
  // on calls that completed: a bad credential answers every call with an error
  // body, which is a successful call carrying no verdict.
  const adjudication = stored.adjudication;
  if (adjudicate && adjudication !== undefined && adjudication.prompts > 0 && adjudication.answered === 0) {
    console.error(
      paint("red", `  All ${adjudication.prompts} adjudication(s) failed. This run makes no claim about the code.`),
    );
    console.error(paint("dim", `  Try: secondpass doctor --probe`));
    console.error("");
    return 2;
  }

  const triggering = stored.findings.filter(
    (f) => f.verdict === "confirmed" && failsThreshold(f.severity, threshold),
  );
  if (triggering.length > 0) {
    if (!flagBool(args, "json")) {
      console.log(
        paint("red", `  ${triggering.length} confirmed finding(s) at or above "${threshold}".`),
      );
      console.log("");
    }
    return 1;
  }
  return 0;
}

/** Re-render the flags for the run record, without ever copying a value that could be secret. */
function formatFlags(args: ParsedArgs): string[] {
  const out: string[] = [];
  for (const [name, value] of args.flags) {
    out.push(value === true ? `--${name}` : `--${name}=${value}`);
  }
  return out;
}

/**
 * Progress on one rewritten line when a human is watching, plain lines when
 * output is piped. Adjudication takes minutes; a command that prints nothing
 * for three minutes is indistinguishable from one that has hung.
 */
function makeProgressReporter(params: {
  quiet: boolean;
  paint: (code: "reset" | "dim" | "bold" | "red" | "yellow" | "blue" | "green", text: string) => string;
}): (event: RunEvent) => void {
  const { quiet, paint } = params;
  const interactive = Boolean(process.stdout.isTTY) && !quiet;
  let startedAt = Date.now();

  const line = (text: string): void => {
    if (quiet) return;
    if (interactive) process.stdout.write(`\r[2K  ${text}`);
    else console.log(`  ${text}`);
  };
  const endLine = (): void => {
    if (interactive && !quiet) process.stdout.write("\n");
  };

  // Nothing settles for the length of a whole adjudication, and the bar below
  // only draws on a settled prompt — so the first prompt's worth of time
  // rendered as a frozen line with no sign the process was alive. A ticking
  // elapsed count is the difference between "working" and "hung" to whoever is
  // deciding whether to hit ^C.
  let waiting: ReturnType<typeof setInterval> | undefined;
  const stopWaiting = (): void => {
    if (waiting === undefined) return;
    clearInterval(waiting);
    waiting = undefined;
  };
  const startWaiting = (candidates: number, prompts: number): void => {
    if (!interactive) return;
    stopWaiting();
    waiting = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      line(paint("dim", `adjudicate ${candidates} candidates in ${prompts} prompts… ${elapsed}s`));
    }, 1000);
    // Never let the ticker be the reason the process stays alive.
    waiting.unref?.();
  };

  return (event) => {
    switch (event.kind) {
      case "scan-started":
        startedAt = Date.now();
        line(paint("dim", "scanning…"));
        break;
      case "scan-complete":
        line(
          `scan       ${event.filesScanned} files · ${event.candidatesFound} candidates in ${event.filesWithCandidates} files · ${(event.durationMs / 1000).toFixed(1)}s`,
        );
        endLine();
        break;
      case "adjudication-skipped":
        line(paint("dim", `adjudicate skipped — ${event.reason}`));
        endLine();
        break;
      case "adjudication-started":
        startedAt = Date.now();
        line(
          paint("dim", `adjudicate ${event.candidates} candidates in ${event.prompts} prompts…`),
        );
        startWaiting(event.candidates, event.prompts);
        break;
      case "adjudication-progress": {
        stopWaiting();
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = event.settled > 0 ? elapsed / event.settled : 0;
        const remaining = Math.max(0, Math.round(rate * (event.total - event.settled)));
        const bar = renderBar(event.settled / event.total);
        line(
          `adjudicate ${bar} ${event.settled}/${event.total}` +
            paint("dim", `  ~${remaining}s left`) +
            (event.ok ? "" : paint("yellow", `  (failed: ${event.filePath})`)),
        );
        if (event.settled === event.total) endLine();
        break;
      }
      case "adjudication-complete":
        stopWaiting();
        line(
          `adjudicate ${event.findings} finding(s) · ${(event.durationMs / 1000).toFixed(1)}s`,
        );
        endLine();
        break;
    }
  };
}

function renderBar(fraction: number): string {
  const width = 20;
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `[${"=".repeat(filled)}${" ".repeat(width - filled)}]`;
}
