// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): sql-injection
// Bound parameters throughout — the driver escapes the value, so it
// never becomes part of the SQL text.

import { db } from "../fixtures/db.js";

export async function revokeSession(token: string): Promise<void> {
  await db.query("DELETE FROM sessions WHERE token = ?", [token]);
}
