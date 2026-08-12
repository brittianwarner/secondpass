// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): auth-bypass
// An environment check does appear here, but it only turns on extra
// logging — it never returns, grants, or otherwise short-circuits the
// real auth call below it.

import type { Context } from "../fixtures/http.js";
import { requireAuth } from "../fixtures/auth.js";
import { logger } from "../fixtures/logger.js";

export async function reportsHandler(c: Context): Promise<Response> {
  if (process.env.NODE_ENV !== "production") {
    logger.debug({ path: c.request.url }, "extra diagnostics enabled in dev mode");
  }

  await requireAuth(c);
  return c.json(await loadReports(c));
}

async function loadReports(c: Context): Promise<Record<string, unknown>> {
  void c;
  return { reports: [] };
}
