// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: sql-injection
// The session token is concatenated into a DELETE statement by hand.
// A token containing a quote breaks out of the string and can delete
// every session in the table.

import { db } from "../fixtures/db.js";

export async function revokeSession(token: string): Promise<void> {
  await db.query("DELETE FROM sessions WHERE token = '" + token + "'");
}
