#!/usr/bin/env bun
/**
 * The secondpass command line.
 *
 * Design constraint, and the reason this exists: a developer should be able
 * to scan their repository with **one API key and nothing else**. No
 * account, no login, no hosted sandbox, no project link, no gateway. If a
 * step in this CLI ever requires a second credential or a browser, it has
 * broken its promise.
 *
 * Commands:
 *   init     scaffold a config (optional — scan works without one)
 *   doctor   check this machine can run a scan, and say exactly what is missing
 *   scan     scan a project and adjudicate what it finds
 *   list     past runs
 *   report   re-render a stored run
 *   export   write a stored run to Markdown
 */

// The published version, from the one file that defines it. Hardcoding it here
// meant `--version` kept reporting whatever the last release was.
import { version } from "../../package.json" with { type: "json" };
import { runInit } from "./commands/init.js";
import { runDoctor } from "./commands/doctor.js";
import { runScanCommand } from "./commands/scan.js";
import { runList } from "./commands/list.js";
import { runReport } from "./commands/report.js";
import { runExport } from "./commands/export.js";

export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string | true>;
}

/**
 * `--flag value`, `--flag=value`, `--bool`, and bare positionals.
 *
 * Hand-rolled rather than pulled from npm: the package ships with three
 * optional dependencies and no required ones, and a flag parser is not
 * worth changing that.
 */
export function parseArgv(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let command: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq > 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(body, next);
        i += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }

    if (command === undefined) command = token;
    else positionals.push(token);
  }

  return { command, positionals, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

const HELP = `secondpass — a two-stage security scanner

  A free deterministic pass finds candidates. A model adjudicates them into
  findings you can act on. The only thing you have to provide is an API key
  for a model you already pay for.

Usage
  secondpass <command> [options]

Commands
  init [dir]              Scaffold secondpass.config.json and INFO.md
  doctor                  Check this machine can run a scan
  scan [dir]              Scan a project and adjudicate the candidates
  list                    Past runs, newest first
  report [run-id]         Re-render a stored run (default: the newest)
  export [run-id]         Write a stored run to Markdown

Common options
  --api-key-env <NAME>    Env var holding the model credential.
                          Auto-detected when omitted.
  --model <id>            Model id. Defaults to the provider's default.
  --json                  Machine-readable output
  --help                  This message

Run \`secondpass <command> --help\` for options specific to a command.

Getting started
  export ANTHROPIC_API_KEY=...     (or OPENROUTER_API_KEY, OPENAI_API_KEY, …)
  cd your-repo
  secondpass scan
`;

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgv(argv);

  // Before the help branch: `secondpass --version` parses to no command at
  // all, so a version check placed after it can never run.
  if (flagBool(args, "version")) {
    console.log(`secondpass ${version}`);
    return 0;
  }
  if (args.command === undefined || args.command === "help") {
    console.log(HELP);
    return 0;
  }

  // Anything a command throws lands here. Without this boundary a malformed
  // config file — or any other unhandled error — printed a Bun stack trace and
  // exited 1, which is the code for "confirmed findings": CI could not tell a
  // broken config from a critical vulnerability. Exit 2 says what is true, that
  // the run never got far enough to make a claim.
  try {
    switch (args.command) {
      case "init":
        return await runInit(args);
      case "doctor":
        return await runDoctor(args);
      case "scan":
        return await runScanCommand(args);
      case "list":
        return await runList(args);
      case "report":
        return await runReport(args);
      case "export":
        return await runExport(args);
      default:
        console.error(`unknown command: ${args.command}\n`);
        console.error(HELP);
        return 64; // EX_USAGE
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("");
    console.error(`  secondpass ${args.command}: ${message}`);
    console.error("");
    return 2;
  }
}

// Only run when invoked as a program, so the module stays importable in tests.
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
