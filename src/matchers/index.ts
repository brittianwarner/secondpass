/**
 * Matcher registry — the single import surface for the default matcher set,
 * plus the tools to extend it.
 *
 * `ALL_MATCHERS` is deliberately framework- and company-agnostic: generic
 * web-app mistakes (`./builtin.ts`) plus concerns any multi-tenant service
 * shares regardless of stack (`./multi-tenancy.ts`). Nothing that depends on
 * one team's conventions ships here — those belong in a pack you write and
 * merge in yourself through `composeMatchers` (README → *Writing your own
 * matcher pack*), because a matcher only your codebase can interpret is
 * noise in everyone else's.
 */

import type { Matcher, NoiseTier } from "../types.js";
import { BUILTIN_MATCHERS } from "./builtin.js";
import { MULTI_TENANCY_MATCHERS } from "./multi-tenancy.js";

export * from "./builtin.js";
export * from "./multi-tenancy.js";

/** The default matcher set — general-purpose, no project-specific families. */
export const ALL_MATCHERS: readonly Matcher[] = [
  ...BUILTIN_MATCHERS,
  ...MULTI_TENANCY_MATCHERS,
];

/** Look up one matcher by its stable `slug`, within the default set. `undefined` if unregistered. */
export function getMatcher(slug: string): Matcher | undefined {
  return ALL_MATCHERS.find((matcher) => matcher.slug === slug);
}

/** Every default-set matcher whose self-reported noise level is exactly `tier`. */
export function matchersForTier(tier: NoiseTier): readonly Matcher[] {
  return ALL_MATCHERS.filter((matcher) => matcher.noiseTier === tier);
}

export interface ComposeMatchersParams {
  /** Starting set — usually `ALL_MATCHERS`, but any array works (e.g. in a test). */
  base: readonly Matcher[];
  /** Extra packs to merge in — your project's own families. */
  packs: readonly (readonly Matcher[])[];
}

/**
 * Merge `base` with one or more packs into the matcher list a scan actually
 * runs. Throws on a duplicate `slug` instead of letting a later pack
 * silently shadow an earlier family — a silent shadow means half the
 * matchers in the merged registry are dead weight nobody notices until a
 * whole class of bug quietly stops getting caught.
 */
export function composeMatchers(params: ComposeMatchersParams): readonly Matcher[] {
  const merged: Matcher[] = [];
  const firstSeenIn = new Map<string, string>();
  const groups: Array<{ name: string; matchers: readonly Matcher[] }> = [
    { name: "base", matchers: params.base },
    ...params.packs.map((pack, index) => ({
      name: `packs[${index}]`,
      matchers: pack,
    })),
  ];

  for (const group of groups) {
    for (const matcher of group.matchers) {
      const existing = firstSeenIn.get(matcher.slug);
      if (existing !== undefined) {
        throw new Error(
          `composeMatchers: duplicate slug "${matcher.slug}" — already ` +
            `registered by ${existing}, redefined by ${group.name}. Every ` +
            "family must have a unique slug across base + packs.",
        );
      }
      firstSeenIn.set(matcher.slug, group.name);
      merged.push(matcher);
    }
  }

  return merged;
}
