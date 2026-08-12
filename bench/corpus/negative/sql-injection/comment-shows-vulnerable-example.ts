// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): sql-injection
// A code-review comment quoting the vulnerable shape as a warning. The
// actual query below is fully parameterized.

import { db } from "../fixtures/db.js";

export async function findUserByEmail(email: string): Promise<unknown> {
  // Do NOT write this: `SELECT * FROM users WHERE email = '${email}'` —
  // that's exactly the injection this function used to have.
  const rows = await db.query("SELECT * FROM users WHERE email = ?", [email]);
  return rows[0] ?? null;
}
