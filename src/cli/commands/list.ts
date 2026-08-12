/**
 * `secondpass list` — what has been run here.
 *
 * Runs are files under `.secondpass/runs/`, so this is a directory listing
 * with the numbers pulled forward. The trend across rows is the useful part:
 * candidates going up while confirmed stays flat is a matcher getting
 * noisier, not a codebase getting worse.
 */

import { buildContext } from "../context.js";
import type { ParsedArgs } from "../index.js";
import { flagBool, flagNumber, flagString } from "../index.js";
import { makePainter, shouldUseColor } from "../render.js";
import { listRuns } from "../store.js";

const HELP = `secondpass list — past runs, newest first

Usage
  secondpass list [options]

Options
  --project <id>   Only this project
  --limit <n>      How many rows. Default 20.
  --json           Machine-readable output
`;

export function runList(args: ParsedArgs): number {
  if (flagBool(args, "help")) {
    console.log(HELP);
    return 0;
  }

  const paint = makePainter({ color: shouldUseColor() });
  const ctx = buildContext(args);
  const projectId = flagString(args, "project");
  const all = listRuns({
    baseDir: ctx.loaded.baseDir,
    ...(projectId === undefined ? {} : { projectId }),
  });
  const rows = all.slice(0, flagNumber(args, "limit") ?? 20);

  if (flagBool(args, "json")) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }

  if (rows.length === 0) {
    console.log("");
    console.log("  No runs yet. `secondpass scan` makes one.");
    console.log("");
    return 0;
  }

  const idWidth = Math.max(6, ...rows.map((r) => r.runId.length));
  const projectWidth = Math.max(7, ...rows.map((r) => r.projectId.length));

  console.log("");
  console.log(
    paint(
      "dim",
      `  ${"run".padEnd(idWidth)}  ${"project".padEnd(projectWidth)}  files  cands  confirmed  ctx  ruled out  err`,
    ),
  );
  for (const row of rows) {
    const confirmed =
      row.confirmed > 0 ? paint("red", String(row.confirmed).padStart(9)) : String(row.confirmed).padStart(9);
    console.log(
      `  ${row.runId.padEnd(idWidth)}  ${row.projectId.padEnd(projectWidth)}  ` +
        `${String(row.filesScanned).padStart(5)}  ${String(row.candidatesFound).padStart(5)}  ${confirmed}  ` +
        `${String(row.needsContext).padStart(3)}  ${String(row.falsePositive).padStart(9)}  ` +
        `${row.errors > 0 ? paint("yellow", String(row.errors).padStart(3)) : String(row.errors).padStart(3)}` +
        (row.adjudicated ? "" : paint("dim", "   (scan only)")),
    );
  }
  if (all.length > rows.length) {
    console.log(paint("dim", `  …and ${all.length - rows.length} older`));
  }
  console.log("");
  return 0;
}
