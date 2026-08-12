// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): sql-injection
// A query-builder ORM call. There is no raw SQL string anywhere in this
// file for user input to reach.

import { db, users } from "../fixtures/db.js";
import { eq } from "../fixtures/query-builder.js";

export async function findUserByEmail(email: string): Promise<unknown> {
  const rows = await db.select().from(users).where(eq(users.email, email));
  return rows[0] ?? null;
}
