/**
 * Multi-tenancy matchers — concerns shared by any service that multiplexes
 * more than one tenant through the same code path, independent of stack.
 *
 * These families started life scoped to one specific platform (a query
 * builder's `organizationId`, one actor framework's key shape, one header
 * prefix) and were generalized once it became clear none of that specificity
 * was load-bearing: a query missing its tenant column, a lookup key
 * assembled by hand instead of passed as structured data, a request header
 * trusted before its provenance was checked, and a shared secret compared
 * byte-by-byte in variable time are the same four bugs in every multi-tenant
 * codebase. Ship these in the default set; put what's actually specific to
 * one project in a pack of your own instead (README → *Writing your own
 * matcher pack*).
 *
 * Same recall-over-precision posture as `./builtin.ts`: bounded regex
 * windows, not a parser or a config surface — a family can both miss a real
 * bug hidden behind a variable and flag a safe one the regex can't see a
 * guard for. `noiseTier` is the honest prior for each family.
 */

import type { Matcher } from "../types.js";

const TS = ["**/*.ts", "**/*.tsx"];

export const tenancyUnscopedQuery: Matcher = {
  slug: "tenancy-unscoped-query",
  description:
    "A data-access call (`.query({...})`, `.find({...})`, `.findMany({...})`, " +
    "`.where({...})`) whose visible options object carries none of the usual " +
    "tenant-discriminator keys — organizationId, orgId, tenantId, accountId, " +
    "workspaceId, customerId. Most data stores enforce no row-level " +
    "isolation of their own: the tenant id passed at the call site IS the " +
    "boundary between tenants. A query built without one is either scoped " +
    "somewhere the regex can't see (spread from a params object built " +
    "elsewhere) or a straight cross-tenant read — the highest-impact bug " +
    "class a multi-tenant service can ship.",
  noiseTier: "high",
  filePatterns: TS,
  examples: [
    "await db.query({ sql, timeoutMs: 30_000 })",
    "await Model.find({ status: 'active' })",
    "await repo.findMany({ where: { deletedAt: null } })",
    "await store.where({ id: recordId })",
  ],
  patterns: [
    {
      // Nested `{}`/`[]` inside the literal (an array-of-objects value,
      // say) can make this bounded lookahead stop short of a later tenant
      // key — an accepted false-negative risk for a regex-only scan.
      regex:
        /\.(?:query|find|findMany|where)\s*\(\s*\{(?![^)]*\b(?:organizationId|orgId|tenantId|accountId|workspaceId|customerId)\b)[^)]{0,500}\)/,
      label: "data-access call literal has no visible tenant-discriminator key",
    },
    {
      // Not an object literal at all — an opaque variable or a builder
      // result. Whether it carries a tenant id can't be decided by regex;
      // flag it and let adjudication trace the value back to its source.
      regex: /\.(?:query|find|findMany|where)\s*\(\s*[a-zA-Z_$][\w.]*\s*\)/,
      label: "data-access call passes an opaque argument — tenant scoping can't be verified statically",
    },
  ],
};

export const actorKeyInjection: Matcher = {
  slug: "actor-key-injection",
  description:
    "A keyed lookup/create call (`getOrCreate`, `get`, `create` against an " +
    "actor, aggregate, or durable-object registry) built from string " +
    "interpolation or concatenation instead of passed as structured data. " +
    "This is a documented footgun for actor frameworks specifically — " +
    "Rivet's own docs (https://rivet.dev/docs/actors/keys) warn against " +
    "building a key like `org:${userId}` — but the failure mode is generic " +
    "to any keyed-lookup API that also happens to accept a raw string: it " +
    "doesn't throw on a malformed key, it silently resolves to (or creates) " +
    "a DIFFERENT instance than the caller intended. For a tenant-scoped " +
    "instance, that means reading or writing someone else's data. `get`/" +
    "`create` are scoped tighter than `getOrCreate` below — both names are " +
    "too common in unrelated APIs (Map.get, Object.create) to flag a bare " +
    "string argument without drowning in noise, so only the concatenation " +
    "shape is covered for them.",
  noiseTier: "normal",
  filePatterns: TS,
  examples: [
    "client.workspace.getOrCreate(`${workspaceId}`)",
    "client.user.get(\"user:\" + userId)",
    "client.session.getOrCreate([sessionId])",
    'client.organization.getOrCreate("organization")',
  ],
  patterns: [
    {
      regex: /\.(?:getOrCreate|create)\s*\(\s*`[^`]*\$\{/,
      label: "key built from a template literal instead of structured data",
    },
    {
      // The one shape worth covering for the generic `get`/`create` names
      // too — string concatenation as a lookup argument is unusual enough
      // outside key-construction to stay a low-noise signal even unscoped.
      regex: /\.(?:getOrCreate|get|create)\s*\(\s*[^,()\[\]]*\+[^,()\[\]]*\)/,
      label: "key built by string concatenation instead of structured data",
    },
    {
      // A single-element array — no comma before the closing bracket — is
      // missing whatever discriminator a [name, id]-shaped key scheme needs.
      regex: /\.(?:getOrCreate|create)\s*\(\s*\[\s*[^,\]\[]+\s*\]\s*\)/,
      label: "single-element array key — most keyed-lookup schemes expect [name, id]",
    },
    {
      regex: /\.(?:getOrCreate|create)\s*\(\s*["'][^"']*["']\s*\)/,
      label: "bare string key instead of structured (array) data",
    },
  ],
};

export const trustedPrincipalHeader: Matcher = {
  slug: "trusted-principal-header",
  description:
    "An identity header (`x-*-user-id`, `x-*-user-email`, `x-forwarded-user`, " +
    "`x-remote-user`, `x-authenticated-*`) read directly off a request. " +
    "These headers only carry a fact once something upstream — a reverse " +
    "proxy, an internal gateway — has authenticated the caller and attached " +
    "them itself; a regex can't see whether that check ran first on THIS " +
    "route, so every hit needs the surrounding handler read to confirm a " +
    "shared-secret or mTLS check gates it. On a route without one, the " +
    "header is just whatever the caller typed — instant impersonation of " +
    "any identity it names.",
  noiseTier: "high",
  filePatterns: TS,
  examples: [
    "const userId = request.headers.get('x-gateway-user-id')",
    "const email = headers['x-internal-user-email']",
    "const user = req.headers.get('x-forwarded-user')",
  ],
  patterns: [
    {
      // `\bheaders` (not `\.headers`) so this also catches a destructured
      // `const { headers } = request` used bare, not only `req.headers`.
      regex:
        /\bheaders\s*(?:\.\s*get\s*\(\s*|\[)\s*["']x-(?:[\w-]*-user-(?:id|email)|forwarded-user|remote-user|authenticated-[\w-]+)["']/i,
      label: "identity header read off a headers object",
    },
    {
      regex:
        /["']x-(?:[\w-]*-user-(?:id|email)|forwarded-user|remote-user|authenticated-[\w-]+)["']/i,
      label: "identity header referenced by name",
    },
  ],
};

export const secretCompareTiming: Matcher = {
  slug: "secret-compare-timing",
  description:
    "A shared secret — an env-var-shaped constant whose name contains " +
    "SECRET, API_KEY, SIGNING_KEY, or HMAC, the convention most services " +
    "use for a webhook/service/internal secret — compared with `===`/`!==` " +
    "instead of a constant-time compare. Variable-time string comparison " +
    "returns as soon as it hits a mismatched byte, so response timing " +
    "leaks how many leading bytes an attacker's guess got right: enough " +
    "signal to recover the whole secret byte-by-byte over enough requests.",
  noiseTier: "low",
  filePatterns: TS,
  examples: [
    "if (received !== process.env.WEBHOOK_SECRET) return unauthorized();",
    "const ok = header === env.SERVICE_API_KEY;",
    "if (sig !== HMAC_SIGNING_KEY) throw new Error('bad signature');",
  ],
  patterns: [
    {
      regex:
        /\b[A-Z][A-Z0-9_]*(?:SECRET|API_KEY|SIGNING_KEY|HMAC)[A-Z0-9_]*\b[^;]{0,100}(?:===?|!==?)/,
      label: "secret-shaped constant compared with a non-constant-time operator",
    },
    {
      // Same check, secret on the right-hand side of the operator.
      regex:
        /(?:===?|!==?)[^;]{0,100}\b[A-Z][A-Z0-9_]*(?:SECRET|API_KEY|SIGNING_KEY|HMAC)[A-Z0-9_]*\b/,
      label: "value compared against a secret-shaped constant with a non-constant-time operator",
    },
  ],
};

export const MULTI_TENANCY_MATCHERS: readonly Matcher[] = [
  tenancyUnscopedQuery,
  actorKeyInjection,
  trustedPrincipalHeader,
  secretCompareTiming,
];
