// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): auth-bypass
// A prose comment about auth bypass, written as separate words rather
// than an identifier. There is no skip/bypass/disable-shaped identifier
// anywhere in this file — the guard below is real and unconditional.

import type { Context } from "../fixtures/http.js";
import { requireAuth } from "../fixtures/auth.js";

export async function billingHandler(c: Context): Promise<Response> {
  // Do not bypass auth here under any circumstance — every billing route
  // must call requireAuth() first, even for internal cron callers.
  await requireAuth(c);
  return c.json(await loadInvoices(c));
}

async function loadInvoices(c: Context): Promise<Record<string, unknown>> {
  void c;
  return { invoices: [] };
}
