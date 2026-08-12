/**
 * The setup every command shares.
 *
 * Three things have to happen before any command can do its job: find the
 * env files and load them, find the config (or decide there isn't one), and
 * work out which project the developer meant. Doing that in one place keeps
 * `scan` and `doctor` from disagreeing about which credential is in play —
 * a `doctor` that passes while `scan` picks a different key would be worse
 * than no `doctor` at all.
 */

import { resolve } from "node:path";

import type { ProjectConfig } from "../types.js";
import { type LoadedConfig, loadConfig, resolveProject } from "./config.js";
import { type CredentialLookup, loadEnvFiles, resolveCredential } from "./credential.js";
import type { ParsedArgs } from "./index.js";
import { flagString } from "./index.js";

export interface CliContext {
  cwd: string;
  loaded: LoadedConfig;
  /** Files a credential was actually read out of. Shown, never quoted from. */
  envFilesRead: string[];
  credential: CredentialLookup;
  /** Model id from --model, then the config. Undefined means the provider default. */
  model: string | undefined;
}

/**
 * `.env` lookup order: the project root first, then the config's directory,
 * then the working directory. Nearest to the code being scanned wins, since
 * that is where a developer keeps the key for that codebase.
 */
export function buildContext(args: ParsedArgs, explicitRoot?: string): CliContext {
  const cwd = process.cwd();
  const loaded = loadConfig({ cwd, ...(explicitRoot === undefined ? {} : { explicitRoot }) });

  const dirs = [
    ...loaded.config.projects.map((p) => resolve(loaded.baseDir, p.root)),
    loaded.baseDir,
    cwd,
  ];
  const envFilesRead = loadEnvFiles({ dirs });

  const explicitEnv = flagString(args, "api-key-env") ?? loaded.config.apiKeyEnv;
  const credential = resolveCredential({
    ...(explicitEnv === undefined ? {} : { explicit: explicitEnv }),
    envFilesRead,
  });

  return {
    cwd,
    loaded,
    envFilesRead,
    credential,
    model: flagString(args, "model") ?? loaded.config.model,
  };
}

export interface SelectedProject {
  project: ProjectConfig;
  /** True when this project came from a config file rather than a bare directory. */
  fromConfig: boolean;
}

/**
 * Pick the project to act on.
 *
 * With one project configured there is nothing to choose. With several, a
 * `--project` id is required rather than guessed: silently scanning the
 * first of five roots is the kind of helpfulness that hides a gap for months.
 */
export function selectProject(
  ctx: CliContext,
  projectId?: string,
): { ok: true; selected: SelectedProject } | { ok: false; error: string } {
  const { projects } = ctx.loaded.config;

  if (projectId) {
    const entry = projects.find((p) => p.id === projectId);
    if (entry === undefined) {
      return {
        ok: false,
        error: `no project "${projectId}" in ${ctx.loaded.configPath ?? "this directory"}. Known: ${projects.map((p) => p.id).join(", ")}`,
      };
    }
    return {
      ok: true,
      selected: {
        project: resolveProject({ entry, baseDir: ctx.loaded.baseDir }),
        fromConfig: ctx.loaded.configPath !== null,
      },
    };
  }

  if (projects.length > 1) {
    return {
      ok: false,
      error:
        `${ctx.loaded.configPath} defines ${projects.length} projects. ` +
        `Pass --project <id>: ${projects.map((p) => p.id).join(", ")}`,
    };
  }

  const entry = projects[0];
  if (entry === undefined) return { ok: false, error: "no projects configured" };
  return {
    ok: true,
    selected: {
      project: resolveProject({ entry, baseDir: ctx.loaded.baseDir }),
      fromConfig: ctx.loaded.configPath !== null,
    },
  };
}
