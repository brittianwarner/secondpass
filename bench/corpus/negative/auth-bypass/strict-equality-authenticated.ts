// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): auth-bypass
// The same shape as a loose-equality bypass, but with strict equality —
// no implicit coercion, no bypassable decision.

import type { Context } from "../fixtures/http.js";
import { decodeSessionCookie } from "../fixtures/auth.js";

export async function accountSettingsHandler(c: Context): Promise<Response> {
  const session = decodeSessionCookie(c);

  if (session.isAuthenticated === true) {
    return c.json(await loadAccountSettings(session.userId));
  }

  return new Response("unauthorized", { status: 401 });
}

async function loadAccountSettings(userId: string): Promise<Record<string, unknown>> {
  return { userId };
}
