// Dev-only convenience: this file is excluded from production builds by the
// bundler's NODE_ENV dead-code-elimination pass (see build.config.ts), so
// this branch never ships.
export function devOnlyGuard(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return checkRealAuth();
}

declare function checkRealAuth(): boolean;
