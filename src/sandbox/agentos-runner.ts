/**
 * secondpass sandbox transport — runs the adjudication model call INSIDE an
 * agentOS VM.
 *
 * WHY A VM AT ALL
 * ---------------
 * Adjudication reasons about untrusted repository content (a `Candidate`
 * snippet, its surrounding file, any hand-curated `ProjectConfig.info`).
 * That content can carry prompt injection aimed at whatever agent reads it.
 * This module never lets it near the host process: the model call itself,
 * plus any tool the model attempts in response to injected instructions,
 * happens inside a disposable agentOS VM with no mount of repository
 * content, no host bindings, and no ability to act on anything except emit
 * text back through the ACP `prompt()` channel.
 *
 * WHY PI, NOT A RAW MODEL API CALL
 * ---------------------------------
 * The model is driven by the `pi` ACP adapter (`@agentos-software/pi`,
 * pinned 0.2.7). pi embeds the SDK and runs INSIDE the VM on the sidecar's
 * native-V8 executor (Node emulation): `createSession` sends
 * it as a guest-VFS path with `runtime: "javascript"` / `jsRuntime.platform:
 * "node"`, and it spawns no subprocess of its own — the only host
 * subprocess is the native `agentos-sidecar` binary. This module drives that
 * adapter rather than calling a model provider's HTTP API from host code,
 * which would defeat the sandboxing goal above.
 *
 * WHY A STANDALONE `AgentOs.create()` EMBED
 * ------------------------------------------
 * agentOS also ships a higher-order actor factory that wraps a VM as a
 * long-lived actor. This module wants the opposite: one VM per adjudication,
 * booted and disposed, holding nothing between calls. A run is a function
 * call, not a service (see this package's README → *Architecture*), so it
 * embeds `AgentOs.create()` directly — the low-level API that factory itself
 * calls underneath — and owns an ephemeral SQLite-file VM database rather
 * than borrowing an actor's. A disposable VM is also the cheaper security
 * story: there is no session for one file's injected instructions to leak
 * into the next file's review.
 *
 * PACKAGE RESOLUTION IS INTENTIONALLY LAZY
 * -----------------------------------------
 * The three agentOS packages are real `dependencies` — a normal install has
 * them — but this module must still type-check and run without them, because
 * everything except adjudication (the scan stage, matcher authoring, prompt
 * building, response parsing) is usable when they are missing or broken, and
 * a resolution failure there should be an error message rather than a crash
 * at import time. So every agentOS import below reads its specifier from a
 * `const` variable rather than an inline string literal: TypeScript only
 * resolves a module's *types* for a literal `import()` specifier, and a
 * computed one type-checks as `Promise<any>` whether or not the package is
 * present (verified against this repo's pinned `typescript@5.9.3` before
 * relying on it).
 *
 * Every such import is wrapped in try/catch; on failure every exported
 * function returns the documented `{ ok: false, error }` shape naming what
 * could not be resolved. Nothing here is stubbed to a fake success — nothing
 * runs without a real VM boot and a real pi session, because a scanner that
 * reports "no findings" when its sandbox never started is worse than one
 * that reports nothing at all.
 */

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Options shared by every sandboxed adjudication call. */
export interface SecondpassSandboxOptions {
  /** Scopes logs/errors and the ephemeral VM database file name. */
  workspaceId: string;
  /**
   * pi model id. Defaults to a model already present in pi 0.2.7's bundled
   * `@mariozechner/pi-ai@0.60.0` built-in catalog for the resolved provider
   * (see {@link DEFAULT_MODEL_BY_PI_PROVIDER}) so no `models.json`
   * custom-model registration is needed. An id pi doesn't recognize does
   * NOT error — `findInitialModel` silently falls back to pi's own default
   * — so prefer the default unless the caller has confirmed their id is in
   * that catalog.
   */
  model?: string;
  /**
   * Name of the env var holding the LLM credential (e.g. "ANTHROPIC_API_KEY",
   * "OPENROUTER_API_KEY"). Only the NAME is ever read from this module's
   * inputs or written to an error/log line — the resolved value rides the
   * one VM session's `env` and nowhere else. Defaults to
   * {@link DEFAULT_API_KEY_ENV}.
   */
  apiKeyEnv?: string;
  /** Bounds VM boot plus one adjudication turn. Default {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Result of one sandboxed adjudication call. Never thrown — see module docstring. */
export type AdjudicationOutcome =
  | { raw: string; ok: true }
  | { ok: false; error: string };

/** One batch item's outcome. `raw` is `null` and `error` is set on failure. */
export interface BatchAdjudicationOutcome {
  filePath: string;
  raw: string | null;
  error?: string;
}

/**
 * Progress report, emitted once per settled batch item.
 *
 * Adjudication is the only stage of a scan that costs money and the only one
 * that takes minutes, and a batch resolves as a single promise — so without
 * this hook a caller has no way to tell a working run from a wedged one, and
 * no way to show a user anything but a spinner. `settled`/`total` are enough
 * to drive both a progress bar and an ETA.
 */
export interface BatchProgress {
  /** Items settled so far, including failures. */
  settled: number;
  /** Total items in the batch. */
  total: number;
  /** The item that just settled. */
  filePath: string;
  /** Whether that item produced a response. */
  ok: boolean;
  /** Wall-clock ms for this item alone. */
  elapsedMs: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Two workers — two VMs, two sidecar processes.
 *
 * Chosen from the curve in `bench/pool-sweep.ts` (8 items, per worker
 * count): 1 -> 16.3s, 2 -> 8.5s (1.91x), 4 -> 6.0s (2.71x). The second
 * worker is very nearly free parallelism; the third and fourth buy a
 * sidecar process each for a 1.42x marginal return. Raise it when a batch
 * is long enough that the extra processes pay for themselves.
 */
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_API_KEY_ENV = "ANTHROPIC_API_KEY";

/**
 * pi's re-vendored (Rust-line) runtime does a strict `chdir(cwd)` at
 * `session/new` that only succeeds for the default persistent layer —
 * chdir into any mounted filesystem fails with `ENOENT … chdir` even when
 * the path exists. `/home/user` is pi's default home and always chdir-able.
 * Mirrors `AGENT_SESSION_CWD` in
 * `packages/actors/src/domains/workspaces/coding-agent-config.ts`.
 */
const AGENT_SESSION_CWD = "/home/user";

/**
 * pi's adapter reads model routing from this settings file via its
 * `SettingsManager`, NOT from a `PI_AGENT_MODEL` env var — see
 * `.claude/rules/agentos.md`. Resolves under `HOME=/home/user` (set on the
 * session env below).
 */
const PI_AGENT_SETTINGS_PATH = "/home/user/.pi/agent/settings.json";

/** Bounded, human-paced adjudication turn — matches the connector-authoring precedent. */
const PI_THINKING_LEVEL = "medium";

/** The one agent type this module ever opens a session as. */
const PI_AGENT_TYPE = "pi";

/**
 * `@mariozechner/pi-ai@0.60.0`'s own `getEnvApiKey()` env-var → provider
 * convention (bundled inside `@agentos-software/pi@0.2.7`, verified against
 * the installed package's `dist/env-api-keys.js`). Mirrored here — not
 * imported, since that package does not resolve from this one (see module
 * docstring) — so `apiKeyEnv` resolves to the `defaultProvider` pi's
 * adapter actually expects.
 */
const PI_PROVIDER_BY_API_KEY_ENV: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: "anthropic",
  OPENROUTER_API_KEY: "openrouter",
  OPENAI_API_KEY: "openai",
  GROQ_API_KEY: "groq",
  CEREBRAS_API_KEY: "cerebras",
  XAI_API_KEY: "xai",
  MISTRAL_API_KEY: "mistral",
};

/**
 * Defaults verified present in pi 0.2.7's bundled `@mariozechner/pi-ai`
 * built-in catalog (checked against the installed package's
 * `dist/models.generated.js`, not guessed) so a scan routes without anyone
 * writing a `models.json` custom-model registration first.
 *
 * `--model` takes any id that catalog knows. An id it does not know fails at
 * session open with pi's own error rather than silently falling back here —
 * a scanner that quietly adjudicates with a different model than you asked
 * for is reporting on work you did not commission.
 */
const DEFAULT_MODEL_BY_PI_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: "claude-sonnet-4-5",
  openrouter: "anthropic/claude-sonnet-4.5",
};

/** Extract a human-readable message from an unknown caught value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ---------------------------------------------------------------------------
// Minimal local shapes of the agentOS SDK surface this module calls.
//
// Hand-rolled rather than imported from `@rivet-dev/agent-os-core`'s own
// types: even though that one package happens to resolve today (see module
// docstring), pinning to locally-owned types keeps this file's `tsc --noEmit`
// result independent of an incidental, undeclared resolution — and keeps the
// three agentOS packages behind one lazy, uniformly-typed loader instead of
// two different resolution strategies. Keep these in sync with the real SDK
// (`@rivet-dev/agent-os-core@0.2.14`, aliased from `@rivet-dev/agentos-core`)
// if the packages are ever added as real dependencies of secondpass.
// ---------------------------------------------------------------------------

interface AgentOsSessionHandle {
  writeFile(path: string, content: string): Promise<void>;
  openSession(input: {
    sessionId: string;
    agent: string;
    cwd?: string;
    env?: Record<string, string>;
    /** Immutable per-session tool-call policy — see `runOneAdjudication`. */
    permissionPolicy?: "reject_all" | "ask" | "allow_all";
    /** The system-prompt channel — ACP's `OpenSessionInput` has no separate field. */
    additionalInstructions?: string;
  }): Promise<void>;
  prompt(input: {
    sessionId: string;
    content: Array<{ type: "text"; text: string }>;
  }): Promise<{
    sessionId: string;
    message: { content?: Array<{ type?: string; text?: string }> } | null;
    stopReason: string;
  }>;
  cancelPrompt(input: { sessionId: string }): Promise<{ status: string }>;
  deleteSession(input: { sessionId: string }): Promise<void>;
  dispose(): Promise<void>;
}

interface AgentOsVmUser {
  uid: number;
  gid: number;
  euid: number;
  egid: number;
  username: string;
  homedir: string;
  shell: string;
}

interface AgentOsCreateOptions {
  user?: AgentOsVmUser;
  software?: unknown[];
  bindings?: unknown[];
  mounts?: Array<Record<string, unknown>>;
  database: { type: "sqlite_file"; path: string };
  /** See `bootSandboxVm`'s `sidecarPool` — agent-os keys sidecar PROCESSES by pool name. */
  sidecar?: { kind: "shared"; pool: string };
}

interface AgentOsStatic {
  create(options: AgentOsCreateOptions): Promise<AgentOsSessionHandle>;
}

type NodeModulesMountFn = (hostDir: string) => Record<string, unknown>;

interface LoadedAgentOsRuntime {
  AgentOs: AgentOsStatic;
  nodeModulesMount: NodeModulesMountFn;
  /** `@agentos-software/common`'s default export — a `SoftwareInput`. */
  common: unknown;
  /** `@agentos-software/pi`'s default export (aliased `@rivet-dev/agent-os-pi`) — registers the "pi" agent. */
  pi: unknown;
}

/**
 * Resolve every agentOS package this module needs, or fail closed.
 *
 * Every specifier below lives in a `const`, never inlined into the
 * `import()` call — load-bearing for `tsc --noEmit`, not a style choice
 * (see the "PACKAGE RESOLUTION IS INTENTIONALLY LAZY" section of the module
 * docstring).
 */
async function loadAgentOsRuntime(): Promise<
  { ok: true; runtime: LoadedAgentOsRuntime } | { ok: false; error: string }
> {
  const coreSpecifier = "@rivet-dev/agent-os-core";
  const commonSpecifier = "@agentos-software/common";
  const piSpecifier = "@rivet-dev/agent-os-pi";
  try {
    const [core, commonMod, piMod] = await Promise.all([
      import(coreSpecifier),
      import(commonSpecifier),
      import(piSpecifier),
    ]);
    const AgentOs = (core as { AgentOs?: unknown }).AgentOs;
    const nodeModulesMount = (core as { nodeModulesMount?: unknown })
      .nodeModulesMount;
    if (typeof AgentOs !== "function" || typeof nodeModulesMount !== "function") {
      return {
        ok: false,
        error:
          "agentos unavailable: @rivet-dev/agent-os-core resolved but is missing its AgentOs/nodeModulesMount exports",
      };
    }
    const common = (commonMod as { default?: unknown }).default ?? commonMod;
    const pi = (piMod as { default?: unknown }).default ?? piMod;
    return {
      ok: true,
      runtime: {
        AgentOs: AgentOs as unknown as AgentOsStatic,
        nodeModulesMount: nodeModulesMount as unknown as NodeModulesMountFn,
        common,
        pi,
      },
    };
  } catch (err) {
    return { ok: false, error: `agentos unavailable: ${errorMessage(err)}` };
  }
}

// ---------------------------------------------------------------------------
// The in-VM node_modules mount — infrastructure, not scanned content.
// ---------------------------------------------------------------------------

/** The transitive dependency whose presence proves a tree is the right one. */
const MOUNT_MARKER = ["@agentclientprotocol", "sdk", "package.json"] as const;
const MOUNT_OVERRIDE_ENV = "SECONDPASS_NODE_MODULES_MOUNT";

let cachedMount: string | null = null;

/**
 * Find the `node_modules` tree to mount at `/root/node_modules` in the VM.
 *
 * The pi adapter runs *inside* the VM and resolves its own dependencies
 * there, so it needs a real nested `node_modules` on the guest filesystem.
 * Without one, `openSession({ agent: "pi" })` fails with
 * `_resolveModule returned non-string for '@agentclientprotocol/sdk'`.
 *
 * A normal install already produces exactly that tree, so this walks up from
 * this file until it finds a `node_modules` containing the marker package as
 * a **real directory**. The realness check is the whole trick: package
 * managers that link dependencies into a content-addressed store (Bun's
 * isolated linker, pnpm) leave symlinks the guest resolver cannot follow, and
 * a tree like that must be skipped rather than mounted and debugged later.
 * Point `SECONDPASS_NODE_MODULES_MOUNT` at a hoisted tree if you are in one
 * of those workspaces — `bun install --linker hoisted` in a scratch directory
 * with `@agentos-software/pi` is enough to make one.
 */
function resolveVmNodeModules(): string {
  if (cachedMount) return cachedMount;

  const override = process.env[MOUNT_OVERRIDE_ENV];
  if (override !== undefined && override.length > 0) {
    if (!existsSync(join(override, ...MOUNT_MARKER))) {
      throw new Error(
        `${MOUNT_OVERRIDE_ENV} is set to ${override}, but ` +
          `${MOUNT_MARKER.join("/")} is not there. It must point at a ` +
          "node_modules directory containing the pi adapter's dependencies.",
      );
    }
    cachedMount = realpathSync(override);
    return cachedMount;
  }

  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < 16; i += 1) {
    const candidate = join(dir, "node_modules");
    const pkgDir = join(candidate, MOUNT_MARKER[0], MOUNT_MARKER[1]);
    // `lstat`, not `stat`: a symlink here is the store layout described
    // above, and following it would report a usable tree that isn't one.
    if (existsSync(join(candidate, ...MOUNT_MARKER)) && !lstatSync(pkgDir).isSymbolicLink()) {
      cachedMount = realpathSync(candidate);
      return cachedMount;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    "secondpass sandbox: could not find a node_modules tree to mount in the " +
      `VM. Looked for ${MOUNT_MARKER.join("/")} as a real directory in every ` +
      `node_modules above ${start}.\n` +
      "    Install the sandbox dependencies:  bun add @agentos-software/pi\n" +
      `    Or point at a hoisted tree:        ${MOUNT_OVERRIDE_ENV}=/path/to/node_modules`,
  );
}

// ---------------------------------------------------------------------------
// VM identity.
// ---------------------------------------------------------------------------

/**
 * Root VM process identity. agentOS >= 0.2.8 enforces POSIX DAC in the guest
 * kernel, and the stock uid-1000 identity cannot create the writable mount
 * point the node_modules mount above needs under `/root`.
 *
 * Root *inside a disposable microVM with no repository mount, no host
 * bindings, and every tool call rejected* is not the privilege it sounds
 * like — there is nothing in there to take. See the SANDBOX BOUNDARY note in
 * `bootSandboxVm`.
 */
const SANDBOX_VM_USER: AgentOsVmUser = {
  uid: 0,
  gid: 0,
  euid: 0,
  egid: 0,
  username: "root",
  homedir: "/root",
  shell: "/bin/sh",
};

// ---------------------------------------------------------------------------
// pi model routing.
// ---------------------------------------------------------------------------

interface PiRouting {
  provider: string;
  model: string;
  apiKeyEnvName: string;
  apiKeyValue: string;
}

/** Resolve provider/model/credential from options + env, or a caller-actionable error. */
function resolvePiRouting(
  options: SecondpassSandboxOptions,
): { ok: true; routing: PiRouting } | { ok: false; error: string } {
  const apiKeyEnvName = options.apiKeyEnv?.trim() || DEFAULT_API_KEY_ENV;
  const apiKeyValue = process.env[apiKeyEnvName]?.trim();
  if (!apiKeyValue) {
    return {
      ok: false,
      error: `secondpass sandbox: missing credential — process.env.${apiKeyEnvName} is not set`,
    };
  }
  const provider = PI_PROVIDER_BY_API_KEY_ENV[apiKeyEnvName];
  if (!provider) {
    return {
      ok: false,
      error: `secondpass sandbox: unrecognized apiKeyEnv "${apiKeyEnvName}" — no known pi provider maps to it`,
    };
  }
  const model = options.model?.trim() || DEFAULT_MODEL_BY_PI_PROVIDER[provider];
  if (!model) {
    return {
      ok: false,
      error: `secondpass sandbox: no default model registered for pi provider "${provider}" — pass options.model explicitly`,
    };
  }
  return { ok: true, routing: { provider, model, apiKeyEnvName, apiKeyValue } };
}

/**
 * `settings.json` content for pi's `SettingsManager`. Only `defaultProvider`
 * / `defaultModel` / `defaultThinkingLevel` — no `providers` block, and
 * therefore no literal credential value, since every model this module
 * routes to (see {@link DEFAULT_MODEL_BY_PI_PROVIDER}) is in pi's built-in
 * catalog and resolves its API key from the session `env` automatically
 * (pi-ai's own `getEnvApiKey`, mirrored above).
 */
function piSettingsFileContent(routing: PiRouting): string {
  return JSON.stringify(
    {
      defaultProvider: routing.provider,
      defaultModel: routing.model,
      defaultThinkingLevel: PI_THINKING_LEVEL,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// VM lifecycle.
// ---------------------------------------------------------------------------

interface SandboxVm {
  agentOs: AgentOsSessionHandle;
  dbPath: string;
}

async function cleanupDbFiles(dbPath: string): Promise<void> {
  // SQLite may leave -wal/-shm siblings; best-effort, ENOENT is expected
  // when a boot failed before the file was ever created.
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${dbPath}${suffix}`).catch(() => {});
  }
}

/**
 * Boot one disposable VM and write its pi model-routing settings. Callers
 * own disposal (`disposeSandboxVm`) on every path, success or failure.
 */
async function bootSandboxVm(input: {
  runtime: LoadedAgentOsRuntime;
  routing: PiRouting;
  workspaceId: string;
  /**
   * Sidecar pool for this VM. agent-os keys its sidecar PROCESSES by pool
   * name and defaults every VM in a process to the single `"default"` pool
   * — so by default, more VMs do not mean more parallelism; they mean more
   * tenants on one sidecar. Pass a distinct pool per concurrent worker to
   * get a real process boundary. See {@link adjudicateBatch}.
   */
  sidecarPool?: string;
}): Promise<SandboxVm> {
  const dbPath = join(
    tmpdir(),
    `secondpass-${input.workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${randomUUID()}.sqlite`,
  );
  const agentOs = await input.runtime.AgentOs.create({
    // Root identity — required for the node_modules mount point below to
    // materialize under agentOS >= 0.2.8's POSIX DAC enforcement.
    user: SANDBOX_VM_USER,
    // pi is the ONLY agent this VM ever registers; `common` is the standard
    // coreutils bundle pi's own tool implementations shell out to.
    software: [input.runtime.common, input.runtime.pi],
    // No host functions exposed to the guest — adjudication has nothing to
    // bind, so there is nothing for a prompt-injected instruction to reach
    // even if it convinces the model to try.
    bindings: [],
    // SANDBOX BOUNDARY: the only mount is the hoisted node_modules the pi
    // adapter needs to resolve its own runtime deps — infrastructure, not
    // scanned content. There is deliberately NO mount of the repository
    // being scanned, no S3 mount, no host-dir mount. The untrusted content
    // enters this VM only as the `prompt` / `system` text arguments to
    // `runOneAdjudication` below, never as filesystem or network access.
    mounts: [input.runtime.nodeModulesMount(resolveVmNodeModules())],
    // A standalone AgentOs client owns its VM database directly (see module
    // docstring). Ephemeral and per-call: removed by `disposeSandboxVm` once
    // this VM is torn down.
    database: { type: "sqlite_file", path: dbPath },
    ...(input.sidecarPool === undefined
      ? {}
      : { sidecar: { kind: "shared" as const, pool: input.sidecarPool } }),
  });
  try {
    await agentOs.writeFile(
      PI_AGENT_SETTINGS_PATH,
      piSettingsFileContent(input.routing),
    );
  } catch (err) {
    // Partial boot: the VM exists but is unroutable. Dispose rather than
    // leaking a live sidecar VM slot and retry-throw for the caller.
    await agentOs.dispose().catch(() => {});
    await cleanupDbFiles(dbPath);
    throw err;
  }
  return { agentOs, dbPath };
}

async function disposeSandboxVm(vm: SandboxVm): Promise<void> {
  await vm.agentOs.dispose().catch(() => {});
  await cleanupDbFiles(vm.dbPath);
}

/**
 * Bound `promise` to `timeoutMs`. On timeout, `onTimeout` fires (best-effort
 * cancellation / cleanup hook) and the returned promise rejects — the
 * underlying `promise` is NOT cancelled by this alone; callers that need
 * guaranteed cleanup of a promise that may resolve later attach their own
 * continuation to it inside `onTimeout` (see `bootSandboxVmBounded`).
 */
function withTimeout<T>(input: {
  promise: Promise<T>;
  timeoutMs: number;
  onTimeout: () => void;
}): Promise<T> {
  const { promise, timeoutMs, onTimeout } = input;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`secondpass sandbox: timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Boot a VM bounded by `timeoutMs`. If boot itself times out, the underlying
 * boot promise keeps running in the background (there is no mid-boot cancel
 * in the SDK) — attach disposal to it so a late success doesn't leak a live
 * VM slot forever.
 */
function bootSandboxVmBounded(input: {
  runtime: LoadedAgentOsRuntime;
  routing: PiRouting;
  workspaceId: string;
  timeoutMs: number;
  sidecarPool?: string;
}): Promise<SandboxVm> {
  const bootPromise = bootSandboxVm(input);
  return withTimeout({
    promise: bootPromise,
    timeoutMs: input.timeoutMs,
    onTimeout: () => {
      void bootPromise.then((vm) => disposeSandboxVm(vm)).catch(() => {});
    },
  });
}

function extractResponseText(
  message: { content?: Array<{ type?: string; text?: string }> } | null,
): string {
  if (!message?.content) return "";
  let text = "";
  for (const block of message.content) {
    if (block?.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

/** Run exactly one prompt/response turn on an already-booted VM. */
async function runOneAdjudication(input: {
  agentOs: AgentOsSessionHandle;
  routing: PiRouting;
  system: string;
  prompt: string;
  timeoutMs: number;
}): Promise<AdjudicationOutcome> {
  const sessionId = randomUUID();
  try {
    const turn = (async (): Promise<string> => {
      await input.agentOs.openSession({
        sessionId,
        agent: PI_AGENT_TYPE,
        cwd: AGENT_SESSION_CWD,
        // Only the credential NAME is ever logged anywhere in this module —
        // the value lives exclusively in this one session's env, scoped to
        // one VM, never echoed back to a caller or an error message.
        env: {
          HOME: AGENT_SESSION_CWD,
          [input.routing.apiKeyEnvName]: input.routing.apiKeyValue,
        },
        // No tool call this session attempts can touch the host or the VM's
        // own mounts — every attempt is auto-denied, never queued for a
        // human. This is the second half of the sandbox boundary (the first
        // half is "nothing is mounted"): even a prompt-injected instruction
        // that convinces the model to try a tool gets an inert rejection,
        // not an execution.
        permissionPolicy: "reject_all",
        additionalInstructions: input.system,
      });
      const result = await input.agentOs.prompt({
        sessionId,
        content: [{ type: "text", text: input.prompt }],
      });
      return extractResponseText(result.message);
    })();
    const raw = await withTimeout({
      promise: turn,
      timeoutMs: input.timeoutMs,
      onTimeout: () => {
        // Best-effort, and named as such: this asks the session to stop, it
        // does not guarantee the in-flight turn does. The VM is disposed
        // either way, which is the guarantee that actually matters.
        void input.agentOs.cancelPrompt({ sessionId }).catch(() => {});
      },
    });
    return { raw, ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    void input.agentOs.deleteSession({ sessionId }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Public transport.
// ---------------------------------------------------------------------------

/**
 * Adjudicate one candidate inside a fresh, disposable agentOS VM.
 *
 * Boots a VM, runs exactly one pi session/prompt turn, disposes the VM —
 * every path, success or failure. Never throws for an expected failure
 * (model error, timeout, VM boot failure, missing/unresolvable agentOS
 * packages); see the module docstring's "PACKAGE RESOLUTION IS
 * INTENTIONALLY LAZY" section for why `{ ok: false }` is a real, common
 * outcome today rather than a defensive edge case.
 */
export async function adjudicateInSandbox(params: {
  prompt: string;
  system: string;
  options: SecondpassSandboxOptions;
}): Promise<AdjudicationOutcome> {
  const routingResult = resolvePiRouting(params.options);
  if (!routingResult.ok) return routingResult;

  const runtimeResult = await loadAgentOsRuntime();
  if (!runtimeResult.ok) return runtimeResult;

  const timeoutMs = params.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let vm: SandboxVm;
  try {
    vm = await bootSandboxVmBounded({
      runtime: runtimeResult.runtime,
      routing: routingResult.routing,
      workspaceId: params.options.workspaceId,
      timeoutMs,
    });
  } catch (err) {
    return {
      ok: false,
      error: `secondpass sandbox: VM boot failed: ${errorMessage(err)}`,
    };
  }

  try {
    return await runOneAdjudication({
      agentOs: vm.agentOs,
      routing: routingResult.routing,
      system: params.system,
      prompt: params.prompt,
      timeoutMs,
    });
  } finally {
    await disposeSandboxVm(vm);
  }
}

/**
 * Adjudicate a batch of candidates across a pool of disposable agentOS VMs.
 *
 * CONCURRENCY IS A PROCESS BOUNDARY, NOT A SESSION ONE
 * ----------------------------------------------------
 * The obvious design — boot one VM, open N pi sessions on it — does not
 * parallelize, and this was measured rather than assumed:
 *
 *   1 VM, 4 sessions   4 trivial adjudications in 7.1s  (per-item 2.0, 3.6, 5.1, 6.9s)
 *   4 VMs, 1 session   4 trivial adjudications in 8.9s  (per-item 8.8, 8.8, 8.9, 8.9s)
 *   1 call alone       2.9s
 *   the same 4 calls straight to the provider's HTTP API: 1.1s wall, 4.2x speedup
 *
 * The provider parallelizes perfectly, so the ceiling is ours. Sessions in
 * one VM queue behind each other (the clean staircase). More VMs did not
 * help either — because `AgentOs.create()` places every VM on the single
 * shared `"default"` sidecar POOL, and agent-os keys sidecar processes by
 * pool name. Four VMs on one sidecar is still one sidecar.
 *
 * So a worker here owns a VM *and* its own sidecar pool. `concurrency` is
 * the number of those workers, and it finally means what it says.
 *
 * Each item still runs on its own pi session, so no conversation state is
 * ever shared between candidates. A failing item is caught in its own
 * worker slot and becomes a per-item error; it never aborts the pool. Every
 * VM is disposed once, on every path.
 */
export async function adjudicateBatch(params: {
  batches: Array<{ filePath: string; prompt: string }>;
  system: string;
  options: SecondpassSandboxOptions;
  /**
   * Workers, each with its own VM and its own sidecar process. Every worker
   * costs a sidecar, so this is a real resource knob, not a free one.
   * Defaults to {@link DEFAULT_CONCURRENCY}.
   */
  concurrency?: number;
  /** Called once per settled item, in completion order. See {@link BatchProgress}. */
  onProgress?: (progress: BatchProgress) => void;
}): Promise<BatchAdjudicationOutcome[]> {
  if (params.batches.length === 0) return [];

  const routingResult = resolvePiRouting(params.options);
  if (!routingResult.ok) {
    const { error } = routingResult;
    return params.batches.map((b) => ({ filePath: b.filePath, raw: null, error }));
  }

  const runtimeResult = await loadAgentOsRuntime();
  if (!runtimeResult.ok) {
    const { error } = runtimeResult;
    return params.batches.map((b) => ({ filePath: b.filePath, raw: null, error }));
  }

  const timeoutMs = params.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const workerCount = Math.max(
    1,
    Math.min(params.concurrency ?? DEFAULT_CONCURRENCY, params.batches.length),
  );

  // Boot every worker's VM up front and in parallel. A worker whose VM never
  // came up is dropped rather than fatal: the surviving workers drain the
  // whole queue, just more slowly. Only if NONE boot is the batch lost.
  type BootOutcome = SandboxVm | { bootError: string };
  const boots = await Promise.all(
    Array.from({ length: workerCount }, async (_, i): Promise<BootOutcome> => {
      try {
        return await bootSandboxVmBounded({
          runtime: runtimeResult.runtime,
          routing: routingResult.routing,
          workspaceId: `${params.options.workspaceId}-w${i}`,
          timeoutMs,
          // The whole point: a distinct pool is a distinct sidecar process.
          sidecarPool: `${params.options.workspaceId}-w${i}`,
        });
      } catch (err) {
        return { bootError: `secondpass sandbox: VM boot failed: ${errorMessage(err)}` };
      }
    }),
  );

  const vms = boots.filter((b): b is SandboxVm => !("bootError" in b));
  if (vms.length === 0) {
    const firstFailure = boots.find((b): b is { bootError: string } => "bootError" in b);
    const error = firstFailure?.bootError ?? "secondpass sandbox: no VM could be booted";
    return params.batches.map((b) => ({ filePath: b.filePath, raw: null, error }));
  }

  try {
    const results = new Array<BatchAdjudicationOutcome>(params.batches.length);
    let nextIndex = 0;
    let settled = 0;

    const workers = vms.map(async (vm): Promise<void> => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= params.batches.length) return;
        const item = params.batches[index];
        if (!item) continue;
        const startedAt = Date.now();
        const outcome = await runOneAdjudication({
          agentOs: vm.agentOs,
          routing: routingResult.routing,
          system: params.system,
          prompt: item.prompt,
          timeoutMs,
        });
        results[index] = outcome.ok
          ? { filePath: item.filePath, raw: outcome.raw }
          : { filePath: item.filePath, raw: null, error: outcome.error };

        settled += 1;
        if (params.onProgress) {
          // A throwing progress callback is the caller's bug, not a reason to
          // lose an adjudication that already succeeded and was already paid
          // for. Swallow it and keep draining the queue.
          try {
            params.onProgress({
              settled,
              total: params.batches.length,
              filePath: item.filePath,
              ok: outcome.ok,
              elapsedMs: Date.now() - startedAt,
            });
          } catch {
            // ignored — see above
          }
        }
      }
    });
    await Promise.all(workers);
    return results;
  } finally {
    await Promise.all(vms.map((vm) => disposeSandboxVm(vm)));
  }
}
