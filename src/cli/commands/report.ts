/**
 * `secondpass report` — re-read a run you already paid for.
 *
 * Adjudication costs money and minutes; looking at its output again should
 * cost neither. A run id prefix is enough, and no id at all means the newest
 * run, because "show me what just happened" is the common case.
 */

import { buildContext } from "../context.js";
import type { ParsedArgs } from "../index.js";
import { flagBool, flagString } from "../index.js";
import { renderRunConsole, renderRunMarkdown } from "../render.js";
import { loadRun } from "../store.js";

const HELP = `secondpass report — re-render a stored run

Usage
  secondpass report [run-id] [options]

  The run id may be a prefix. Omit it for the most recent run.

Options
  --project <id>   Only consider runs for this project
  --all            Include ruled-out candidates
  --markdown       Markdown instead of the terminal report
  --json           The raw run record
`;

export function runReport(args: ParsedArgs): number {
  if (flagBool(args, "help")) {
    console.log(HELP);
    return 0;
  }

  const ctx = buildContext(args);
  const runId = args.positionals[0];
  const projectId = flagString(args, "project");
  const loaded = loadRun({
    baseDir: ctx.loaded.baseDir,
    ...(runId === undefined ? {} : { runId }),
    ...(projectId === undefined ? {} : { projectId }),
  });

  if (!loaded.ok) {
    console.error(loaded.error);
    return 2;
  }

  const options = { all: flagBool(args, "all") };
  if (flagBool(args, "json")) console.log(JSON.stringify(loaded.run, null, 2));
  else if (flagBool(args, "markdown")) console.log(renderRunMarkdown(loaded.run, options));
  else console.log(renderRunConsole(loaded.run, options));

  return 0;
}
