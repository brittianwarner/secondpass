/**
 * `secondpass export` — a run as a file you can hand to someone.
 *
 * Markdown by default because that is what a pull request comment, a ticket,
 * and a wiki all accept without conversion. JSON is there for the tool you
 * are going to write that this CLI did not anticipate.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { stateDir } from "../config.js";
import { buildContext } from "../context.js";
import type { ParsedArgs } from "../index.js";
import { flagBool, flagString } from "../index.js";
import { makePainter, renderRunMarkdown, shouldUseColor } from "../render.js";
import { loadRun } from "../store.js";

const HELP = `secondpass export — write a stored run to a file

Usage
  secondpass export [run-id] [options]

Options
  --out <path>     Where to write. Default .secondpass/reports/<run-id>.md
  --format <fmt>   markdown | json. Default markdown.
  --project <id>   Only consider runs for this project
  --all            Include ruled-out candidates
  --stdout         Write to stdout instead of a file
`;

export function runExport(args: ParsedArgs): number {
  if (flagBool(args, "help")) {
    console.log(HELP);
    return 0;
  }

  const paint = makePainter({ color: shouldUseColor() });
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

  const format = flagString(args, "format") ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    console.error(`unknown --format "${format}". Use markdown or json.`);
    return 2;
  }

  const body =
    format === "json"
      ? `${JSON.stringify(loaded.run, null, 2)}\n`
      : renderRunMarkdown(loaded.run, { all: flagBool(args, "all") });

  if (flagBool(args, "stdout")) {
    process.stdout.write(body);
    return 0;
  }

  const outPath =
    flagString(args, "out") ??
    join(
      stateDir(ctx.loaded.baseDir),
      "reports",
      `${loaded.run.runId}.${format === "json" ? "json" : "md"}`,
    );

  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, body, "utf8");
  } catch (err) {
    console.error(`could not write ${outPath}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  console.log(`${paint("green", "wrote")} ${outPath}`);
  return 0;
}
