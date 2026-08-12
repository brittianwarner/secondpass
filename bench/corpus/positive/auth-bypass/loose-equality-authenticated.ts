// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: auth-bypass
// Loose equality on a security decision. `session.isAuthenticated` is
// read from a deserialized cookie payload; if it ever arrives as the
// string "false" or the number 0 in a way `==` coerces favorably, or if
// an attacker can influence the field's type, the loose compare is the
// kind of decision that should never tolerate coercion.

import type { Context } from "../fixtures/http.js";
import { decodeSessionCookie } from "../fixtures/auth.js";

export async function accountSettingsHandler(c: Context): Promise<Response> {
  const session = decodeSessionCookie(c);

  if (session.isAuthenticated == true) {
    return c.json(await loadAccountSettings(session.userId));
  }

  return new Response("unauthorized", { status: 401 });
}

async function loadAccountSettings(userId: string): Promise<Record<string, unknown>> {
  return { userId };
}
