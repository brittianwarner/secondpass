/**
 * Project configuration — optional by design.
 *
 * `secondpass scan` works in a repo with no config at all: the directory is
 * the project, its basename is the id, and the default matchers run. A
 * config file exists to hold the things that genuinely cannot be inferred —
 * the project context block that lifts finding quality more than anything
 * else, extra ignore globs, and (in a monorepo) the several roots you want
 * scanned separately.
 *
 * The file is JSON, not TypeScript. A TS config would be more expressive,
 * but it would also mean the scanner executes code from the repository it
 * is scanning before it has scanned it, and that trade is not worth an
 * arrow function.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const CONFIG_FILE_NAME = "secondpass.config.json";
export const STATE_DIR_NAME = ".secondpass";

export interface ProjectEntry {
  /** Stable id. Namespaces runs on disk. */
  id: string;
  /** Path to the project root, absolute or relative to the config file. */
  root: string;
  /**
   * Path to a Markdown file whose contents are injected into every
   * adjudication prompt, relative to the config file. See
   * `INFO.md` in the scaffold for what belongs in it.
   */
  info?: string;
  /** Extra ignore globs on top of the package defaults. */
  ignore?: string[];
}

export interface SecondpassConfig {
  projects: ProjectEntry[];
  /** Env var NAME holding the model credential. A default for `--api-key-env`. */
  apiKeyEnv?: string;
  /** Model id passed to the sandbox. Omit for the provider's default. */
  model?: string;
}

export interface LoadedConfig {
  config: SecondpassConfig;
  /** Absolute path to the config file, or null when running configless. */
  configPath: string | null;
  /** Directory that anchors relative paths: the config's dir, or cwd. */
  baseDir: string;
}

/** Walk up from `startDir` looking for a config file. Stops at the filesystem root. */
export function findConfigFile(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function assertShape(value: unknown, configPath: string): SecondpassConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${configPath}: expected a JSON object`);
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) {
    throw new Error(`${configPath}: "projects" must be a non-empty array`);
  }
  const projects: ProjectEntry[] = raw.projects.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${configPath}: projects[${i}] must be an object`);
    }
    const p = entry as Record<string, unknown>;
    if (typeof p.id !== "string" || p.id.trim().length === 0) {
      throw new Error(`${configPath}: projects[${i}].id must be a non-empty string`);
    }
    if (typeof p.root !== "string" || p.root.trim().length === 0) {
      throw new Error(`${configPath}: projects[${i}].root must be a non-empty string`);
    }
    if (p.ignore !== undefined && !Array.isArray(p.ignore)) {
      throw new Error(`${configPath}: projects[${i}].ignore must be an array of globs`);
    }
    return {
      id: p.id.trim(),
      root: p.root,
      ...(typeof p.info === "string" ? { info: p.info } : {}),
      ...(Array.isArray(p.ignore) ? { ignore: p.ignore.map(String) } : {}),
    };
  });

  const ids = new Set<string>();
  for (const p of projects) {
    if (ids.has(p.id)) throw new Error(`${configPath}: duplicate project id "${p.id}"`);
    ids.add(p.id);
  }

  return {
    projects,
    ...(typeof raw.apiKeyEnv === "string" ? { apiKeyEnv: raw.apiKeyEnv } : {}),
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
  };
}

/**
 * Load the config, or synthesize one from a directory.
 *
 * `explicitRoot` (a path argument to `scan`) always wins — a developer who
 * points the scanner at a directory means that directory, config or not.
 */
export function loadConfig(params: { cwd: string; explicitRoot?: string }): LoadedConfig {
  const { cwd } = params;

  if (params.explicitRoot) {
    const root = isAbsolute(params.explicitRoot)
      ? params.explicitRoot
      : resolve(cwd, params.explicitRoot);
    return {
      config: { projects: [{ id: basename(root) || "project", root }] },
      configPath: null,
      baseDir: cwd,
    };
  }

  const configPath = findConfigFile(cwd);
  if (configPath === null) {
    return {
      config: { projects: [{ id: basename(resolve(cwd)) || "project", root: resolve(cwd) }] },
      configPath: null,
      baseDir: resolve(cwd),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(
      `${configPath}: not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { config: assertShape(parsed, configPath), configPath, baseDir: dirname(configPath) };
}

export interface InfoFile {
  /** `absent` no file · `template` scaffolded but unanswered · `filled` real context. */
  state: "absent" | "template" | "filled";
  /** The text to inject. Only set when `state === "filled"`. */
  text?: string;
  path?: string;
}

/**
 * Read a project context file, and refuse to inject an unanswered one.
 *
 * `secondpass init` writes an INFO.md that is entirely headings and HTML
 * comments asking questions. Injecting that verbatim would put
 * `<!-- One paragraph. Public API? -->` into every adjudication prompt —
 * tokens spent to tell the model nothing, and a template heading like
 * "What looks dangerous but is fine?" with no answer under it reads as a
 * claim that the question was considered. So: strip the comments, and if
 * only headings remain, treat the file as unfilled.
 */
export function readInfoFile(path: string): InfoFile {
  if (!existsSync(path)) return { state: "absent" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { state: "absent" };
  }
  const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  const hasProse = withoutComments
    .split("\n")
    .some((line) => line.trim().length > 0 && !line.trim().startsWith("#"));
  if (!hasProse) return { state: "template", path };
  return { state: "filled", text: withoutComments, path };
}

/** Resolve one config entry into the absolute-path form the scanner wants. */
export function resolveProject(params: {
  entry: ProjectEntry;
  baseDir: string;
}): { id: string; root: string; info?: string; ignore?: string[] } {
  const { entry, baseDir } = params;
  const root = isAbsolute(entry.root) ? entry.root : resolve(baseDir, entry.root);

  const info = entry.info
    ? readInfoFile(isAbsolute(entry.info) ? entry.info : resolve(baseDir, entry.info))
    : { state: "absent" as const };

  return {
    id: entry.id,
    root,
    ...(info.text === undefined ? {} : { info: info.text }),
    ...(entry.ignore === undefined ? {} : { ignore: entry.ignore }),
  };
}

/** The context-file state for a config entry, for commands that report on it. */
export function projectInfoState(params: { entry: ProjectEntry; baseDir: string }): InfoFile {
  const { entry, baseDir } = params;
  if (!entry.info) return { state: "absent" };
  return readInfoFile(isAbsolute(entry.info) ? entry.info : resolve(baseDir, entry.info));
}

/** Where runs for this workspace are stored. */
export function stateDir(baseDir: string): string {
  return join(baseDir, STATE_DIR_NAME);
}
