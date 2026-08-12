/**
 * Finding the model credential — the only thing secondpass asks a developer for.
 *
 * There is no account, no login, no project link, no hosted sandbox, and no
 * gateway. You export one API key for a provider you already pay for, and
 * the scanner runs. That is the whole setup story, and this module is what
 * makes it true: it looks for a key the developer already has, in the
 * places they already keep it, and names the variable it picked.
 *
 * The variable NAME is the only thing this module ever returns, logs, or
 * prints. The value is read exactly once — by the sandbox module, into one
 * VM session's env — and never travels back through here.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every credential the sandbox can route, in the order we prefer them.
 *
 * The order is not arbitrary: Anthropic and OpenRouter are the two the
 * adjudication prompt has actually been measured against, so a developer
 * with several keys set gets a configuration someone has evidence for.
 * The rest work — pi resolves them from the session env the same way —
 * they just have not been benchmarked here.
 */
export const SUPPORTED_API_KEY_ENVS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
];

/** Files we will read a credential out of, nearest first. */
const ENV_FILE_NAMES: readonly string[] = [".env.local", ".env"];

export interface CredentialResolution {
  /** The env var NAME that will carry the credential. Never the value. */
  apiKeyEnv: string;
  /** Where it came from, for the "using X" line. */
  source: "flag" | "environment" | "env-file";
  /** Set when `source === "env-file"`. Absolute path. */
  envFilePath?: string;
  /** Other supported vars that were also set — reported so the pick is never a surprise. */
  alsoAvailable: string[];
}

export type CredentialLookup =
  | { ok: true; resolution: CredentialResolution }
  | { ok: false; error: string; searched: string[]; envFilesRead: string[] };

/**
 * Parse a dotenv file well enough to find an API key.
 *
 * Deliberately small: `KEY=value`, optional `export ` prefix, optional
 * single or double quotes, `#` comments, blank lines. It does NOT do
 * variable interpolation or multi-line values — a key that needs either of
 * those is not an API token, and guessing would be worse than missing it.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing `# comment` only on unquoted values.
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (value.length > 0) out.set(key, value);
  }
  return out;
}

/**
 * Load `.env.local` / `.env` from the given directories into `process.env`,
 * without overwriting anything already set.
 *
 * Real precedence, and the reason it is this way round: an exported shell
 * variable is a deliberate act for this one command, and a file is a
 * default. The deliberate act wins.
 *
 * Returns the files it actually read, so `doctor` can show its work.
 */
export function loadEnvFiles(params: { dirs: readonly string[] }): string[] {
  const read: string[] = [];
  const seen = new Set<string>();
  for (const dir of params.dirs) {
    for (const name of ENV_FILE_NAMES) {
      const path = join(dir, name);
      if (seen.has(path) || !existsSync(path)) continue;
      seen.add(path);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue; // unreadable is the same as absent
      }
      let usedAny = false;
      for (const [key, value] of parseEnvFile(text)) {
        if (process.env[key] === undefined) {
          process.env[key] = value;
          usedAny = true;
        }
      }
      if (usedAny) read.push(path);
    }
  }
  return read;
}

/**
 * Decide which credential this run will use.
 *
 * `explicit` (from `--api-key-env`) is honoured even if unset, so the error
 * names the variable the developer asked for rather than silently picking a
 * different one.
 */
export function resolveCredential(params: {
  explicit?: string;
  envFilesRead?: readonly string[];
}): CredentialLookup {
  const envFilesRead = [...(params.envFilesRead ?? [])];
  const explicit = params.explicit?.trim();

  if (explicit) {
    if (!process.env[explicit]?.trim()) {
      return {
        ok: false,
        error: `--api-key-env named ${explicit}, but that variable is not set`,
        searched: [explicit],
        envFilesRead,
      };
    }
    if (!SUPPORTED_API_KEY_ENVS.includes(explicit)) {
      return {
        ok: false,
        error:
          `${explicit} is set, but secondpass does not know which provider it belongs to. ` +
          `Supported: ${SUPPORTED_API_KEY_ENVS.join(", ")}`,
        searched: [explicit],
        envFilesRead,
      };
    }
    return {
      ok: true,
      resolution: {
        apiKeyEnv: explicit,
        source: "flag",
        alsoAvailable: SUPPORTED_API_KEY_ENVS.filter(
          (name) => name !== explicit && Boolean(process.env[name]?.trim()),
        ),
      },
    };
  }

  const present = SUPPORTED_API_KEY_ENVS.filter((name) => Boolean(process.env[name]?.trim()));
  const picked = present[0];
  if (picked === undefined) {
    return {
      ok: false,
      error:
        "no model credential found. Export one of these and run again:\n" +
        SUPPORTED_API_KEY_ENVS.map((name) => `      export ${name}=...`).join("\n") +
        "\n    or put it in a .env file next to the project you are scanning.",
      searched: [...SUPPORTED_API_KEY_ENVS],
      envFilesRead,
    };
  }

  return {
    ok: true,
    resolution: {
      apiKeyEnv: picked,
      source: envFilesRead.length > 0 ? "env-file" : "environment",
      ...(envFilesRead[0] === undefined ? {} : { envFilePath: envFilesRead[0] }),
      alsoAvailable: present.slice(1),
    },
  };
}
