/**
 * Turning a run into something a person reads.
 *
 * Two audiences, two renderers. The terminal output is for the developer
 * who just ran the scan and wants to know whether to care; the Markdown is
 * for the pull request, the ticket, or the person who was not there. Both
 * lead with confirmed findings, because a report that opens with a tally of
 * false positives has buried the only part that matters.
 *
 * Nothing here re-derives a verdict. The adjudication stage already decided;
 * this module only orders and formats.
 */

import type { Finding, Severity, Verdict } from "../types.js";
import type { StoredRun } from "./store.js";

/** Worst first. A report sorted any other way makes the reader do the triage. */
const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low"];
const VERDICT_ORDER: readonly Verdict[] = ["confirmed", "needs-context", "false-positive"];

const severityRank = (s: Severity): number => {
  const i = SEVERITY_ORDER.indexOf(s);
  return i === -1 ? SEVERITY_ORDER.length : i;
};
const verdictRank = (v: Verdict): number => {
  const i = VERDICT_ORDER.indexOf(v);
  return i === -1 ? VERDICT_ORDER.length : i;
};

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      verdictRank(a.verdict) - verdictRank(b.verdict) ||
      severityRank(a.severity) - severityRank(b.severity) ||
      b.confidence - a.confidence ||
      a.filePath.localeCompare(b.filePath) ||
      (a.lineNumbers[0] ?? 0) - (b.lineNumbers[0] ?? 0),
  );
}

/** `src/db.ts:42` — clickable in most terminals, greppable in all of them. */
export function locate(finding: Finding): string {
  const first = finding.lineNumbers[0];
  return first === undefined ? finding.filePath : `${finding.filePath}:${first}`;
}

const ANSI = {
  reset: "[0m",
  dim: "[2m",
  bold: "[1m",
  red: "[31m",
  yellow: "[33m",
  blue: "[34m",
  green: "[32m",
} as const;

/**
 * Colour only when a human is looking at a terminal.
 * Honours NO_COLOR (https://no-color.org) because piping a report into a
 * file and getting escape codes is a small, avoidable insult.
 */
export function makePainter(params: { color: boolean }): (code: keyof typeof ANSI, text: string) => string {
  if (!params.color) return (_code, text) => text;
  return (code, text) => `${ANSI[code]}${text}${ANSI.reset}`;
}

export function shouldUseColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "") return true;
  return Boolean(process.stdout.isTTY);
}

const severityColor: Record<Severity, keyof typeof ANSI> = {
  critical: "red",
  high: "red",
  medium: "yellow",
  low: "blue",
};

export interface RenderOptions {
  /** Include false positives and needs-context entries. */
  all?: boolean;
  color?: boolean;
}

/** The terminal report. */
export function renderRunConsole(run: StoredRun, options: RenderOptions = {}): string {
  const paint = makePainter({ color: options.color ?? shouldUseColor() });
  const sorted = sortFindings(run.findings);
  const confirmed = sorted.filter((f) => f.verdict === "confirmed");
  const needsContext = sorted.filter((f) => f.verdict === "needs-context");
  const falsePositive = sorted.filter((f) => f.verdict === "false-positive");
  const shown = options.all ? sorted : [...confirmed, ...needsContext];

  const lines: string[] = [];
  lines.push("");
  lines.push(
    `${paint("bold", "secondpass")} ${paint("dim", `${run.projectId} · run ${run.runId}`)}`,
  );
  lines.push("");

  lines.push(
    `  scanned ${run.scan.filesScanned} files · ${run.scan.candidatesFound} candidates in ${run.scan.filesWithCandidates} files · ${(run.scan.durationMs / 1000).toFixed(1)}s`,
  );

  if (!run.adjudicated) {
    lines.push(paint("dim", "  adjudication was not run — these are candidates, not findings"));
    lines.push("");
    lines.push(renderCandidateTally(run, paint));
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    `  ${paint("bold", String(confirmed.length))} confirmed · ${needsContext.length} needs context · ${falsePositive.length} ruled out`,
  );
  lines.push("");

  if (shown.length === 0) {
    // "Nothing confirmed" is only good news if adjudication actually returned
    // verdicts. With no verdicts at all, the green line would be announcing a
    // clean bill of health for work that never happened.
    if (sorted.length === 0 && run.scan.candidatesFound > 0) {
      lines.push(
        paint("yellow", "  No verdicts returned.") +
          paint("dim", ` ${run.scan.candidatesFound} candidate(s) went unadjudicated — this run makes no claim.`),
      );
    } else {
      lines.push(
        paint("green", "  Nothing confirmed.") +
          paint("dim", ` All ${falsePositive.length} candidate(s) were ruled out by adjudication.`),
      );
    }
    lines.push("");
  }

  for (const finding of shown) {
    // Three verdicts, three tags. Collapsing "ruled out" into "NEEDS CONTEXT"
    // would contradict the tally two lines above and tell the reader a
    // candidate is still open when adjudication closed it.
    const tag =
      finding.verdict === "confirmed"
        ? paint(severityColor[finding.severity], finding.severity.toUpperCase())
        : finding.verdict === "needs-context"
          ? paint("dim", "NEEDS CONTEXT")
          : paint("dim", "RULED OUT");
    lines.push(`  ${tag}  ${paint("bold", locate(finding))}  ${paint("dim", finding.vulnSlug)}`);
    lines.push(`    ${finding.summary}`);
    if (finding.failureScenario) lines.push(paint("dim", `    how it breaks: ${finding.failureScenario}`));
    lines.push(paint("dim", `    ${finding.rationale}`));
    lines.push(paint("dim", `    confidence ${finding.confidence.toFixed(2)}`));
    lines.push("");
  }

  if (!options.all && falsePositive.length > 0) {
    lines.push(
      paint("dim", `  ${falsePositive.length} ruled-out candidate(s) hidden — pass --all to see them.`),
    );
    lines.push("");
  }

  if (run.errors.length > 0) {
    lines.push(paint("yellow", `  ${run.errors.length} error(s) during this run:`));
    for (const err of run.errors.slice(0, 10)) lines.push(paint("dim", `    ${err}`));
    if (run.errors.length > 10) {
      lines.push(paint("dim", `    …and ${run.errors.length - 10} more (see the run record)`));
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function renderCandidateTally(
  run: StoredRun,
  paint: (code: keyof typeof ANSI, text: string) => string,
): string {
  const bySlug = new Map<string, number>();
  for (const file of run.files) {
    for (const candidate of file.candidates) {
      bySlug.set(candidate.vulnSlug, (bySlug.get(candidate.vulnSlug) ?? 0) + 1);
    }
  }
  const rows = [...bySlug.entries()].sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return paint("green", "  No candidates. Nothing for the model to look at.");
  const width = Math.max(...rows.map(([slug]) => slug.length));
  return rows
    .map(([slug, count]) => `  ${slug.padEnd(width)}  ${paint("dim", String(count))}`)
    .join("\n");
}

/** Candidates grouped by family, then listed by location. */
function markdownCandidates(run: StoredRun): string[] {
  const bySlug = new Map<string, string[]>();
  for (const file of run.files) {
    for (const candidate of file.candidates) {
      const first = candidate.lineNumbers[0];
      const list = bySlug.get(candidate.vulnSlug) ?? [];
      list.push(first === undefined ? file.filePath : `${file.filePath}:${first}`);
      bySlug.set(candidate.vulnSlug, list);
    }
  }
  if (bySlug.size === 0) return ["## Candidates", "", "None. The deterministic pass found nothing.", ""];

  const rows = [...bySlug.entries()].sort((a, b) => b[1].length - a[1].length);
  const out: string[] = ["## Candidates", "", "| family | count |", "| --- | ---: |"];
  for (const [slug, hits] of rows) out.push(`| \`${slug}\` | ${hits.length} |`);
  out.push("");

  for (const [slug, hits] of rows) {
    out.push(`### \`${slug}\` — ${hits.length}`);
    out.push("");
    for (const hit of hits) out.push(`- \`${hit}\``);
    out.push("");
  }
  return out;
}

/** The Markdown report — for a PR comment, a ticket, or a teammate. */
export function renderRunMarkdown(run: StoredRun, options: RenderOptions = {}): string {
  const sorted = sortFindings(run.findings);
  const confirmed = sorted.filter((f) => f.verdict === "confirmed");
  const needsContext = sorted.filter((f) => f.verdict === "needs-context");
  const falsePositive = sorted.filter((f) => f.verdict === "false-positive");

  const out: string[] = [];
  out.push(`# secondpass — ${run.projectId}`);
  out.push("");
  out.push(`- run: \`${run.runId}\``);
  out.push(`- started: ${run.startedAt}`);
  out.push(`- root: \`${run.rootPath}\``);
  out.push(
    `- scan: ${run.scan.filesScanned} files, ${run.scan.candidatesFound} candidates in ${run.scan.filesWithCandidates} files`,
  );
  if (run.invocation.model) out.push(`- model: \`${run.invocation.model}\``);
  if (run.invocation.apiKeyEnv) out.push(`- credential: \`$${run.invocation.apiKeyEnv}\``);
  out.push("");

  // A scan-only run has no findings, so the verdict table would be three
  // zeroes and the report would say nothing. Show what the free pass
  // actually found instead — labelled as candidates, which is what they are.
  if (!run.adjudicated) {
    out.push("> Adjudication was not run. Everything below is a **candidate**, not a");
    out.push("> finding: a location worth a reviewer's attention, not a vulnerability.");
    out.push("");
    out.push(...markdownCandidates(run));
    return `${out.join("\n")}\n`;
  }

  out.push("## Summary");
  out.push("");
  out.push("| verdict | count |");
  out.push("| --- | ---: |");
  out.push(`| confirmed | ${confirmed.length} |`);
  out.push(`| needs context | ${needsContext.length} |`);
  out.push(`| ruled out | ${falsePositive.length} |`);
  out.push("");

  const sections: Array<[string, Finding[]]> = [
    ["Confirmed", confirmed],
    ["Needs context", needsContext],
  ];
  if (options.all) sections.push(["Ruled out", falsePositive]);

  for (const [title, findings] of sections) {
    if (findings.length === 0) continue;
    out.push(`## ${title}`);
    out.push("");
    for (const f of findings) {
      out.push(`### \`${locate(f)}\` — ${f.summary}`);
      out.push("");
      out.push(
        `- family: \`${f.vulnSlug}\`${f.verdict === "confirmed" ? ` · severity: **${f.severity}**` : ""} · confidence: ${f.confidence.toFixed(2)}`,
      );
      if (f.lineNumbers.length > 1) out.push(`- lines: ${f.lineNumbers.join(", ")}`);
      out.push("");
      if (f.failureScenario) {
        out.push(`**How it breaks.** ${f.failureScenario}`);
        out.push("");
      }
      out.push(f.rationale);
      out.push("");
    }
  }

  if (run.errors.length > 0) {
    out.push("## Errors");
    out.push("");
    for (const err of run.errors) out.push(`- ${err}`);
    out.push("");
  }

  return `${out.join("\n")}\n`;
}
