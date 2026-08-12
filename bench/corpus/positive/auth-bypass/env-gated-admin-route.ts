// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: auth-bypass
// A local-dev convenience check that was never removed. An operator who
// sets NODE_ENV to anything other than "production" (staging, "test",
// a typo) sails past the auth guard entirely.

import type { Context } from "../fixtures/http.js";
import { requireAuth } from "../fixtures/auth.js";

export async function adminDashboardHandler(c: Context): Promise<Response> {
  if (process.env.NODE_ENV !== "production") {
    return next();
  }

  await requireAuth(c);
  return c.json(await loadAdminDashboard());
}

function next(): Response {
  return new Response(null, { status: 200 });
}

async function loadAdminDashboard(): Promise<Record<string, unknown>> {
  return { widgets: [] };
}
