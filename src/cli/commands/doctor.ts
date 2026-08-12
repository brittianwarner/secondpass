/**
 * `secondpass doctor` — can this machine run a scan, and if not, what exactly
 * is missing?
 *
 * The point of this command is that the answer to "it didn't work" should
 * never be "read the source". Every check that fails prints the one command
 * that fixes it. `--probe` goes further and spends a few cents proving the
 * credential really reaches a model, because a key that is *set* and a key
 * that *works* are different claims and only one of them is worth trusting.
 */

import type { ParsedArgs } from "../index.js";
import { flagBool, flagString } from "../index.js";
import { projectInfoState } from "../config.js";
import { buildContext, selectProject } from "../context.js";
import { SUPPORTED_API_KEY_ENVS } from "../credential.js";
import { makePainter, shouldUseColor } from "../render.js";

const HELP = `secondpass doctor — check this machine can run a scan

Usage
  secondpass doctor [options]

Options
  --probe              Make one real (cheap) model call to prove the
                       credential works end to end
  --api-key-env <NAME> Check this variable instead of auto-detecting
  --project <id>       Check a specific project from the config
  --json               Machine-readable output
`;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Shown only when the check failed. The literal command that fixes it. */
  fix?: string;
  /** A check that is informational — never blocks a scan. */
  advisory?: boolean;
}

/** Are the agentOS packages actually resolvable from here? */
async function checkAgentOsRuntime(): Promise<Check> {
  const packages = [
    "@rivet-dev/agent-os-core",
    "@rivet-dev/agent-os-pi",
    "@agentos-software/common",
  ];
  const missing: string[] = [];
  for (const name of packages) {
    try {
      await import(name);
    } catch {
      missing.push(name);
    }
  }
  if (missing.length === 0) {
    return { name: "agentOS runtime", ok: true, detail: `${packages.length} packages resolved` };
  }
  return {
    name: "agentOS runtime",
    ok: false,
    detail: `cannot resolve ${missing.join(", ")}`,
    fix: `bun add ${missing.join(" ")}`,
  };
}

export async function runDoctor(args: ParsedArgs): Promise<number> {
  if (flagBool(args, "help")) {
    console.log(HELP);
    return 0;
  }

  const paint = makePainter({ color: shouldUseColor() });
  const ctx = buildContext(args);
  const checks: Check[] = [];

  checks.push({
    name: "runtime",
    ok: true,
    detail: `bun ${Bun.version} on ${process.platform}-${process.arch}`,
  });

  checks.push(
    ctx.loaded.configPath === null
      ? {
          name: "config",
          ok: true,
          advisory: true,
          detail: "none found — running configless (that is fine; `secondpass init` adds one)",
        }
      : { name: "config", ok: true, detail: ctx.loaded.configPath },
  );

  const selected = selectProject(ctx, flagString(args, "project"));
  if (selected.ok) {
    const { project } = selected.selected;
    let readable = false;
    try {
      readable = (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: project.root, onlyFiles: false }))).length >= 0;
    } catch {
      readable = false;
    }
    checks.push({
      name: "project",
      ok: readable,
      detail: readable ? `${project.id} → ${project.root}` : `cannot read ${project.root}`,
      ...(readable ? {} : { fix: `check the path exists: ls ${project.root}` }),
    });
    const entry = ctx.loaded.config.projects.find((p) => p.id === project.id);
    const info =
      entry === undefined
        ? { state: "absent" as const }
        : projectInfoState({ entry, baseDir: ctx.loaded.baseDir });
    checks.push({
      name: "project context",
      ok: true,
      advisory: true,
      detail:
        info.state === "filled"
          ? `${project.info?.length ?? 0} chars will ride every adjudication`
          : info.state === "template"
            ? `${info.path} is still the template — answer its questions and finding quality jumps`
            : "no context file — findings will be fine, context makes them better (`secondpass init`)",
    });
  } else {
    checks.push({ name: "project", ok: false, detail: selected.error });
  }

  if (ctx.envFilesRead.length > 0) {
    checks.push({
      name: "env files",
      ok: true,
      advisory: true,
      detail: `read ${ctx.envFilesRead.join(", ")}`,
    });
  }

  if (ctx.credential.ok) {
    const { resolution } = ctx.credential;
    const extra =
      resolution.alsoAvailable.length > 0
        ? ` (also set: ${resolution.alsoAvailable.join(", ")})`
        : "";
    checks.push({
      name: "credential",
      ok: true,
      detail: `$${resolution.apiKeyEnv} from ${resolution.source}${extra}`,
    });
  } else {
    checks.push({
      name: "credential",
      ok: false,
      detail: ctx.credential.error,
      fix: `export ${SUPPORTED_API_KEY_ENVS[0]}=...`,
    });
  }

  checks.push(await checkAgentOsRuntime());

  // The probe is last: it is the only check that costs money, so it only
  // runs once everything it depends on has already passed.
  if (flagBool(args, "probe")) {
    const blockers = checks.filter((c) => !c.ok && c.advisory !== true);
    if (blockers.length > 0) {
      checks.push({
        name: "live probe",
        ok: false,
        detail: "skipped — fix the checks above first",
      });
    } else {
      checks.push(await probeModel({ ctx, args }));
    }
  }

  if (flagBool(args, "json")) {
    console.log(JSON.stringify({ checks }, null, 2));
  } else {
    console.log("");
    for (const check of checks) {
      const mark = check.ok
        ? paint("green", "  ok  ")
        : check.advisory
          ? paint("yellow", "  --  ")
          : paint("red", " fail ");
      console.log(`${mark} ${check.name.padEnd(16)} ${paint("dim", check.detail)}`);
      if (!check.ok && check.fix) console.log(`       ${" ".repeat(16)} ${paint("bold", check.fix)}`);
    }
    console.log("");
  }

  const failed = checks.filter((c) => !c.ok && c.advisory !== true);
  if (failed.length > 0) {
    if (!flagBool(args, "json")) {
      console.log(paint("red", `  ${failed.length} check(s) failed — a scan will not work yet.`));
      console.log("");
    }
    return 1;
  }
  if (!flagBool(args, "json")) {
    console.log(paint("green", "  Ready. Run `secondpass scan`."));
    console.log("");
  }
  return 0;
}

/**
 * One real call, the smallest one we can make.
 *
 * This is the check that distinguishes "the variable is set" from "the
 * credential is valid, the provider is reachable, and the sandbox can boot".
 * Those are the three things that actually break, and none of them are
 * visible from the environment alone.
 */
async function probeModel(params: {
  ctx: ReturnType<typeof buildContext>;
  args: ParsedArgs;
}): Promise<Check> {
  const { ctx } = params;
  const startedAt = Date.now();
  try {
    const { adjudicateInSandbox } = await import("../../sandbox/agentos-runner.js");
    const result = await adjudicateInSandbox({
      prompt: "Reply with exactly: OK",
      system: "You are a connectivity probe. Reply with exactly the word OK and nothing else.",
      options: {
        workspaceId: "secondpass-doctor-probe",
        timeoutMs: 120_000,
        ...(ctx.credential.ok ? { apiKeyEnv: ctx.credential.resolution.apiKeyEnv } : {}),
        ...(ctx.model === undefined ? {} : { model: ctx.model }),
      },
    });
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (!result.ok) {
      return {
        name: "live probe",
        ok: false,
        detail: `${result.error} (after ${elapsed}s)`,
        fix: "check the key is valid and has credit with its provider",
      };
    }
    return {
      name: "live probe",
      ok: true,
      detail: `model answered in ${elapsed}s`,
    };
  } catch (err) {
    return {
      name: "live probe",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
