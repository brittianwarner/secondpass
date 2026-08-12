/**
 * `secondpass init` — write a config and a context file.
 *
 * Init is optional. `secondpass scan` works in a bare directory, and saying so
 * out loud matters: a setup command that is secretly mandatory is just a
 * login step wearing a different hat. What init actually buys you is the
 * INFO.md context block, which does more for finding quality than any other
 * input, and a place to record several roots in a monorepo.
 *
 * It never overwrites. A second `init` reports what already exists and
 * stops — the config is a file a human edits, and clobbering someone's
 * curated context to be "helpful" is unforgivable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { CONFIG_FILE_NAME, STATE_DIR_NAME } from "../config.js";
import { SUPPORTED_API_KEY_ENVS, loadEnvFiles, resolveCredential } from "../credential.js";
import type { ParsedArgs } from "../index.js";
import { flagBool, flagString } from "../index.js";
import { makePainter, shouldUseColor } from "../render.js";

const HELP = `secondpass init — scaffold a config and a project context file

Usage
  secondpass init [dir] [options]

Options
  --id <name>          Project id. Defaults to the directory name.
  --api-key-env <NAME> Record a credential variable in the config
  --model <id>         Record a default model in the config
  --force              Overwrite an existing config (INFO.md is never touched)
`;

/**
 * The context template.
 *
 * Every prompt in it is aimed at the same thing: the facts a reviewer could
 * not possibly infer from one file. The headings are questions rather than
 * labels because a blank section under "Architecture" gets skipped and a
 * blank section under "What would an attacker go after first?" does not.
 */
function infoTemplate(projectId: string): string {
  return `# ${projectId} — context for security review

<!--
  This file is injected verbatim into every adjudication prompt.

  It is the highest-leverage thing you can give the scanner. The model can
  read any single file perfectly well; what it cannot do is know that
  \`requireOrg()\` is your auth boundary, that one directory is generated,
  or that the scary-looking \`eval\` in the build script only ever sees
  literals you wrote. Tell it those things here and stop re-litigating the
  same false positives every run.

  Delete the prompts as you answer them. Keep it under a page.
-->

## What does this codebase do, and who can reach it?

<!-- One paragraph. Public API? Internal tool? Multi-tenant SaaS? CLI? -->

## What is the trust boundary?

<!--
  Where does untrusted input enter? Which functions are the gate?
  e.g. "Every route under src/api is public. Auth is enforced by
  requireSession() in src/auth/guard.ts — a handler without it is a bug."
-->

## What are the crown jewels?

<!--
  What would an attacker actually want? Customer data, billing, the
  signing key, the ability to run code on the box?
-->

## What looks dangerous but is fine?

<!--
  The most valuable section. Name the patterns that will keep getting
  flagged and explain why they are safe.
  e.g. "src/migrations/* builds SQL by concatenation. Those strings are
  developer-authored constants, never request data."
-->

## What is out of scope?

<!-- Generated code, vendored trees, fixtures, anything you don't own. -->
`;
}

export function runInit(args: ParsedArgs): number {
  if (flagBool(args, "help")) {
    console.log(HELP);
    return 0;
  }

  const paint = makePainter({ color: shouldUseColor() });
  const target = resolve(process.cwd(), args.positionals[0] ?? ".");
  if (!existsSync(target)) {
    console.error(`no such directory: ${target}`);
    return 1;
  }

  const projectId = flagString(args, "id") ?? (basename(target) || "project");
  const configPath = join(target, CONFIG_FILE_NAME);
  const infoPath = join(target, "INFO.md");
  const created: string[] = [];
  const kept: string[] = [];

  if (existsSync(configPath) && !flagBool(args, "force")) {
    kept.push(configPath);
  } else {
    const config = {
      $schema: "https://secondpass.dev/schema/v1.json",
      ...(flagString(args, "api-key-env") === undefined
        ? {}
        : { apiKeyEnv: flagString(args, "api-key-env") }),
      ...(flagString(args, "model") === undefined ? {} : { model: flagString(args, "model") }),
      projects: [{ id: projectId, root: ".", info: "INFO.md" }],
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    created.push(configPath);
  }

  if (existsSync(infoPath)) {
    kept.push(infoPath);
  } else {
    writeFileSync(infoPath, infoTemplate(projectId), "utf8");
    created.push(infoPath);
  }

  // Run records are local state, not source. Adding the ignore line here
  // saves every user the same small surprise in their next `git status`.
  const gitignorePath = join(target, ".gitignore");
  const ignoreLine = `${STATE_DIR_NAME}/`;
  if (existsSync(join(target, ".git")) || existsSync(gitignorePath)) {
    const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    if (!current.split("\n").some((line) => line.trim() === ignoreLine)) {
      writeFileSync(
        gitignorePath,
        `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}${ignoreLine}\n`,
        "utf8",
      );
      created.push(`${gitignorePath} (+ ${ignoreLine})`);
    }
  }
  mkdirSync(join(target, STATE_DIR_NAME), { recursive: true });

  console.log("");
  for (const path of created) console.log(`  ${paint("green", "created")}  ${path}`);
  for (const path of kept) console.log(`  ${paint("dim", "kept   ")}  ${path}`);
  console.log("");

  const envFilesRead = loadEnvFiles({ dirs: [target, process.cwd()] });
  const credential = resolveCredential({
    ...(flagString(args, "api-key-env") === undefined
      ? {}
      : { explicit: flagString(args, "api-key-env") as string }),
    envFilesRead,
  });

  console.log(`  ${paint("bold", "Next")}`);
  console.log("");
  if (credential.ok) {
    console.log(`    1. Credential found: ${paint("bold", `$${credential.resolution.apiKeyEnv}`)}`);
  } else {
    console.log(`    1. Export a model API key — any one of these:`);
    for (const name of SUPPORTED_API_KEY_ENVS.slice(0, 3)) {
      console.log(paint("dim", `         export ${name}=...`));
    }
  }
  console.log(`    2. Fill in ${paint("bold", "INFO.md")} — it is worth more than any flag here`);
  console.log(`    3. ${paint("bold", "secondpass scan")}`);
  console.log("");
  return 0;
}
