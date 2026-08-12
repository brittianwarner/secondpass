/**
 * General-purpose matchers for TypeScript/JavaScript services.
 *
 * Tuned for RECALL, not precision — adjudication is what removes noise.
 * A matcher that misses a real bug costs far more than one that fires
 * ten extra times, because only the miss is invisible.
 *
 * `noiseTier` is the honest self-assessment of each family. Be truthful
 * there: it is the prior the model reasons from, and an optimistic tier
 * on a noisy family degrades every verdict in that family.
 */

import type { Matcher } from "../types.js";

const TS = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mts"];

export const authBypass: Matcher = {
  slug: "auth-bypass",
  description:
    "Auth guards, session checks, and middleware that may be skippable",
  noiseTier: "normal",
  filePatterns: TS,
  examples: [
    "if (process.env.NODE_ENV !== 'production') return next();",
    "const skipAuth = true;",
    "if (user?.isAdmin || req.body.isAdmin) { … }",
  ],
  patterns: [
    {
      regex: /\b(?:skip|bypass|disable|ignore)[_A-Za-z]*[Aa]uth\w*\b/,
      label: "identifier names an auth skip",
    },
    {
      // Trusting a client-supplied role/admin flag.
      regex:
        /\b(?:req|request|body|params|query|input|payload)\s*(?:\.|\[["'])\s*(?:isAdmin|is_admin|role|roles|isSuperuser|permissions)\b/,
      label: "privilege field read off the request",
    },
    {
      // An environment check standing in for an authorization check.
      regex:
        /if\s*\([^)]*NODE_ENV\s*(?:!==?|===?)\s*["'](?:production|prod)["'][^)]*\)\s*\{?[^}]{0,120}\b(?:return|next|allow|grant|continue)\b/,
      label: "environment check gating an auth path",
    },
    {
      regex: /\/\/\s*(?:TODO|FIXME|HACK|XXX)[^\n]{0,80}\bauth\w*/i,
      label: "unfinished auth work flagged in a comment",
    },
    {
      // `== ` on a security decision — coercion is a classic bypass.
      regex:
        /\b(?:isAdmin|isOwner|isAuthenticated|hasAccess|canEdit|authorized)\s*==\s*(?!=)/,
      label: "loose equality on an authorization boolean",
    },
  ],
};

export const sqlInjection: Matcher = {
  slug: "sql-injection",
  description: "SQL assembled by string concatenation or interpolation",
  noiseTier: "normal",
  filePatterns: TS,
  examples: [
    "`SELECT * FROM ${table} WHERE id = ${id}`",
    'db.query("DELETE FROM t WHERE k = \'" + key + "\'")',
  ],
  patterns: [
    {
      regex:
        /`[^`]*\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\b[^`]*\$\{/i,
      label: "template-literal SQL with interpolation",
    },
    {
      // The quote type is captured and tempered with a backreference so the
      // OTHER quote can appear inside the string — `"… k = '" + key` is the
      // single most common shape of this bug, and a naive [^"'] class dies on
      // the embedded quote before it ever reaches the `+`. Bounded repetition
      // keeps the tempered dot from backtracking on a long line.
      regex:
        /(["'])(?:(?!\1).){0,200}\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b(?:(?!\1).){0,200}\1\s*\+/i,
      label: "SQL string built by concatenation",
    },
    {
      // Interpolated identifier positions — never parameterizable, so
      // these need an allowlist or an identifier validator.
      regex: /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+\$\{/i,
      label: "interpolated table/identifier position",
    },
    {
      regex: /\bORDER\s+BY\s+\$\{|\bORDER\s+BY\s*["']?\s*\+/i,
      label: "interpolated ORDER BY — identifier, not a value",
    },
  ],
};

export const ssrf: Matcher = {
  slug: "ssrf",
  description: "Outbound requests to a caller-influenced URL",
  noiseTier: "high",
  filePatterns: TS,
  examples: ["await fetch(req.body.url)", "axios.get(`${base}/${userPath}`)"],
  patterns: [
    {
      regex:
        /\b(?:fetch|axios(?:\.\w+)?|got|undici\.request|request)\s*\(\s*(?:req|request|body|params|query|input|payload)\s*[.[]/,
      label: "outbound request to a request-derived URL",
    },
    {
      regex:
        /\b(?:fetch|axios(?:\.\w+)?|got)\s*\(\s*`[^`]*\$\{(?!\s*(?:process\.env|env|BASE|API_|config)\w*)/,
      label: "outbound request to an interpolated URL",
    },
    {
      regex: /\bnew\s+URL\s*\(\s*(?:req|request|body|params|query|input)\s*[.[]/,
      label: "URL constructed from request input",
    },
  ],
};

export const secretInLog: Matcher = {
  slug: "secret-in-log",
  description: "Credentials or tokens reaching logs, traces, or responses",
  noiseTier: "high",
  filePatterns: TS,
  examples: [
    "logger.info({ apiKey }, 'calling provider')",
    "console.log('token', token)",
  ],
  patterns: [
    {
      // `token`, `jwt`, `bearer`, and `session` are deliberately included even
      // though they are common words. This family is noiseTier "high" — the
      // adjudicator is expected to discard the misses, and a logged bearer
      // token is worth several false alarms.
      regex:
        /\b(?:console\.(?:log|info|warn|error|debug)|logger?\.(?:log|info|warn|error|debug|trace))\s*\([^)]{0,200}\b(password|passwd|secret|apiKey|api_key|accessToken|access_token|refreshToken|privateKey|private_key|clientSecret|credential|token|jwt|bearer|session)\b/i,
      // The credential word must be an IDENTIFIER, not log prose. Without
      // this, `` `… session=${id}` `` and "Failed to refresh apiKey" both
      // fire — on a real 2.3 MB codebase that was most of this family.
      codeOnlyGroup: 1,
      label: "secret-named identifier passed to a logger",
    },
    {
      // Whole-object logging of things that usually carry credentials.
      regex:
        /\b(?:console\.\w+|logger?\.\w+)\s*\(\s*(?:JSON\.stringify\s*\(\s*)?(?:process\.env|config|env|credentials|session|headers)\s*[,)]/,
      label: "credential-bearing object logged wholesale",
    },
    {
      regex:
        /\b(?:res|reply|response)\s*\.\s*(?:json|send)\s*\([^)]{0,160}\b(?:password|secret|apiKey|accessToken|privateKey|clientSecret)\b/i,
      label: "secret returned in an HTTP response body",
    },
  ],
};

export const xss: Matcher = {
  slug: "xss",
  description: "Unescaped values reaching an HTML sink",
  noiseTier: "normal",
  filePatterns: [...TS, "**/*.svelte"],
  examples: ["el.innerHTML = userInput", "{@html comment}"],
  patterns: [
    {
      // Excluded: the empty-string clear (`el.innerHTML = ""`) and
      // assignment straight out of a known sanitizer. The sanitizer list is
      // deliberately short and exact-named — a longer, fuzzier list starts
      // swallowing helpers merely NAMED "sanitize" that sanitize nothing,
      // and a false negative here is unrecoverable.
      regex:
        /\.innerHTML\s*=(?!\s*(?:["'`]\s*["'`]|(?:DOMPurify|dompurify)\s*\.\s*sanitize\s*\(|sanitizeHtml\s*\(|sanitizeHTML\s*\(|xss\s*\())\s*/,
      label: "assignment to innerHTML",
    },
    {
      regex: /\bdangerouslySetInnerHTML\b/,
      label: "dangerouslySetInnerHTML",
    },
    {
      regex: /(\{@html)(?!\s+["'])\s+/,
      codeOnlyGroup: 1,
      label: "Svelte {@html} with a non-literal expression",
    },
    {
      regex: /\bdocument\.write\s*\(/,
      label: "document.write",
    },
    {
      regex: /\.insertAdjacentHTML\s*\(/,
      label: "insertAdjacentHTML",
    },
  ],
};

export const unsafeRedirect: Matcher = {
  slug: "unsafe-redirect",
  description: "Redirect target taken from caller-controlled input",
  noiseTier: "normal",
  filePatterns: TS,
  examples: ["redirect(303, url.searchParams.get('next'))"],
  patterns: [
    {
      regex:
        /\b(?:redirect|sendRedirect)\s*\(\s*(?:\d{3}\s*,\s*)?(?:req|request|body|params|query|url\.searchParams|searchParams)\b/,
      label: "redirect target read from request input",
    },
    {
      regex:
        /\b(?:location\.href|location\.replace|window\.location)\s*(?:=|\()(?!\s*["'`]\/)\s*/,
      label: "browser navigation to a non-literal target",
    },
    {
      regex:
        /["']Location["']\s*[,:]\s*(?:req|request|body|params|query|searchParams)\b/,
      label: "Location header set from request input",
    },
  ],
};

export const corsWildcard: Matcher = {
  slug: "cors-wildcard",
  description: "Permissive CORS — wildcard origin or reflected Origin header",
  noiseTier: "normal",
  filePatterns: TS,
  examples: [
    "'Access-Control-Allow-Origin': '*'",
    "res.setHeader('Access-Control-Allow-Origin', req.headers.origin)",
  ],
  patterns: [
    {
      regex: /["']Access-Control-Allow-Origin["']\s*[,:]\s*["']\*["']/,
      label: "wildcard CORS origin",
    },
    {
      // Reflecting the caller's Origin is wildcard-with-credentials.
      regex:
        /["']Access-Control-Allow-Origin["']\s*[,:]\s*(?:req|request)\s*\.\s*headers/,
      label: "CORS origin reflected from the request",
    },
    {
      regex: /\borigin\s*:\s*(?:true|["']\*["'])/,
      label: "CORS middleware configured to allow any origin",
    },
  ],
};

export const jwtHandling: Matcher = {
  slug: "jwt-handling",
  description: "JWT decoded without verification, or verified weakly",
  noiseTier: "normal",
  filePatterns: TS,
  examples: ["jwt.decode(token)", "verify(token, key, { algorithms: ['none'] })"],
  patterns: [
    {
      regex: /\bjwt\s*\.\s*decode\s*\(|\bdecodeJwt\s*\(/,
      label: "JWT decoded without signature verification",
    },
    {
      regex: /algorithms?\s*:\s*\[?\s*["'](?:none|HS256)["']/i,
      label: "weak or absent JWT algorithm",
    },
    {
      regex: /\bignoreExpiration\s*:\s*true|\bverify\s*:\s*false/,
      label: "token expiry or verification disabled",
    },
    {
      // Splitting a JWT by hand almost always means skipping verify.
      regex: /\.split\s*\(\s*["']\.["']\s*\)\s*\[\s*1\s*\]/,
      label: "JWT payload extracted by string splitting",
    },
  ],
};

export const insecureCrypto: Matcher = {
  slug: "insecure-crypto",
  description: "Broken primitives, weak randomness, non-constant-time compares",
  noiseTier: "normal",
  filePatterns: TS,
  examples: [
    "createHash('md5')",
    "if (token === expected) …",
    "Math.random().toString(36)",
  ],
  patterns: [
    {
      regex: /\bcreateHash\s*\(\s*["'](?:md5|sha1)["']/i,
      label: "broken hash algorithm",
    },
    {
      regex: /\bcreateCipheriv?\s*\(\s*["'][^"']*(?:des|rc4|ecb)/i,
      label: "broken cipher or ECB mode",
    },
    {
      // Math.random() for anything that reads like a credential.
      regex:
        /\b(?:token|secret|key|nonce|salt|password|id)\w*\s*=\s*[^;\n]{0,60}\bMath\.random\s*\(/i,
      label: "credential derived from Math.random()",
    },
    {
      // The canonical weak-id idiom. Worth its own pattern rather than relying
      // on the assignment form above: it is frequently used inline as an
      // argument (`createUser({ id: Math.random().toString(36) })`), where
      // there is no `x = ` prefix to anchor on.
      regex: /\bMath\.random\s*\(\s*\)\s*\.\s*toString\s*\(\s*(?:36|16|2)\s*\)/,
      label: "Math.random().toString(radix) — weak id/token generation",
    },
    {
      // Timing-unsafe comparison of a secret.
      regex:
        /\b(?:secret|token|signature|hmac|digest|apiKey|password)\w*\s*(?:===?|!==?)\s*(?!undefined|null)\w/i,
      label: "secret compared with a non-constant-time operator",
    },
  ],
};

export const rce: Matcher = {
  slug: "rce",
  description: "Dynamic code or shell execution",
  noiseTier: "normal",
  filePatterns: TS,
  examples: [
    "exec(`git checkout ${branch}`)",
    "new Function(src)",
    "cp.execSync(`tar -xf ${archivePath}`)",
    '$`rm -rf ${targetDir}`',
  ],
  patterns: [
    // `exec`/`execSync` as a BARE identifier — the `import { exec } from
    // "node:child_process"` shape. The lookbehind excluding `.` is
    // load-bearing: `\bexec` also matches the tail of `RE.exec(s)`, i.e.
    // RegExp.prototype.exec, which is not code execution and is everywhere.
    // Without it this family scored a 100% false-positive rate on a real
    // 236-file codebase — 13 hits, all of them regex matching.
    {
      regex: /\b(?:exec|execSync|spawnSync)\s*\(\s*`[^`]*\$\{/,
      notPrecededBy: /[.\w$]/,
      label: "shell command with an interpolated argument",
    },
    {
      regex: /\b(?:exec|execSync)\s*\((?!\s*["'`])\s*/,
      notPrecededBy: /[.\w$]/,
      label: "shell command from a non-literal string",
    },
    // A quoted command prefix concatenated with something else —
    // `exec("git log " + branch)`. Neither pattern above sees it: the first
    // wants a template literal, and the second's lookahead deliberately
    // skips anything opening with a quote. Bounded tempered dot for the same
    // reason as the SQL concatenation pattern, so an embedded quote inside
    // the command string does not end the match early.
    {
      regex: /\b(?:exec|execSync|spawnSync)\s*\(\s*(["'])(?:(?!\1).){0,200}\1\s*\+/,
      notPrecededBy: /[.\w$]/,
      label: "shell command built by concatenation",
    },
    // The member-access form the lookbehind above deliberately drops. Scoped
    // to receivers that actually name the child_process module, so it reads
    // `cp.exec(...)` without also reading `pattern.exec(...)`.
    {
      regex:
        /\b(?:child_process|node:child_process|childProcess|cp)\s*\.\s*(?:exec|execSync|spawnSync)\s*\(/,
      label: "child_process exec through a module binding",
    },
    // `execFile`/`spawn` are the SAFE child_process APIs — they take an
    // argv array and do not invoke a shell, which is exactly why careful
    // code reaches for them. Flagging them wholesale is noise. Two shapes
    // are worth waking a model for; a bare dynamic first argument is not
    // (measured: 8 hits across two real packages, 8 of them false — literal
    // binaries wrapped onto the next line, `process.execPath`, and a local
    // helper function that merely happened to be named `spawn`).
    {
      regex: /\bshell\s*:\s*true\b/,
      label: "child process spawned with `shell: true` — argv re-enters a shell",
    },
    {
      regex:
        /\b(?:execFile|execFileSync|spawn|spawnSync)\s*\(\s*`[^`]*\$\{/,
      notPrecededBy: /[.\w$]/,
      label: "child process whose executable path is interpolated",
    },
    {
      regex: /\bnew\s+Function\s*\(|\beval\s*\(/,
      label: "dynamic code evaluation",
    },
    {
      regex: /\bBun\s*\.\s*\$\s*`[^`]*\$\{/,
      label: "Bun shell template with interpolation",
    },
    // `import { $ } from "bun"` — the destructured form. Missed entirely
    // before, which made it a false negative rather than mere noise: a shell
    // interpolation nobody was looking at. `$` followed by a backtick is a
    // tagged template; `${` inside an ordinary template can't reach here.
    {
      regex: /\$\s*`[^`]*\$\{/,
      notPrecededBy: /[.\w$]/,
      label: "shell template with interpolation (destructured Bun `$`)",
    },
  ],
};

export const nonAtomicReadDelete: Matcher = {
  slug: "non-atomic-read-delete",
  description: "Check-then-act races on shared state",
  noiseTier: "high",
  filePatterns: TS,
  examples: ["if (await has(k)) { await del(k) }"],
  patterns: [
    {
      regex:
        /if\s*\(\s*await\s+[\w.]*(?:has|exists|get|find)\w*\s*\([^)]*\)\s*\)\s*\{[^}]{0,200}\bawait\s+[\w.]*(?:delete|del|remove|consume)\w*\s*\(/,
      label: "await-check then await-delete — not atomic",
    },
    {
      regex:
        /\bconst\s+\w+\s*=\s*await\s+[\w.]*(?:get|read)\w*\s*\([^)]*\)[^;]*;\s*(?:\/\/[^\n]*\n\s*)?await\s+[\w.]*(?:set|write|update)\w*\s*\(/,
      label: "read-modify-write without a guard",
    },
  ],
};

export const testHeaderBypass: Matcher = {
  slug: "test-header-bypass",
  description: "Headers or flags that weaken security outside tests",
  noiseTier: "normal",
  filePatterns: TS,
  examples: ["if (req.headers['x-test-user']) { … }"],
  patterns: [
    {
      regex:
        /["'](?:x-test-[\w-]+|x-debug-[\w-]+|x-bypass-[\w-]+|x-skip-[\w-]+)["']/i,
      label: "test/debug header consulted at runtime",
    },
    {
      regex:
        /\bprocess\.env\s*\.\s*\w*(?:DISABLE|SKIP|BYPASS|ALLOW_INSECURE|UNSAFE)\w*\b/,
      label: "environment flag that weakens a control",
    },
  ],
};

export const BUILTIN_MATCHERS: readonly Matcher[] = [
  authBypass,
  sqlInjection,
  ssrf,
  secretInLog,
  xss,
  unsafeRedirect,
  corsWildcard,
  jwtHandling,
  insecureCrypto,
  rce,
  nonAtomicReadDelete,
  testHeaderBypass,
];
