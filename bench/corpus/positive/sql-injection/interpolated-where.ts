// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: sql-injection
// A user-controlled email is interpolated straight into a WHERE clause.
// An email of `' OR '1'='1` returns every row in the table.

import { db } from "../fixtures/db.js";

export async function findUserByEmail(email: string): Promise<unknown> {
  const rows = await db.query(`SELECT * FROM users WHERE email = '${email}'`);
  return rows[0] ?? null;
}
