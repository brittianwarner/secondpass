// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: sql-injection
// The sort column comes straight from the query string and is
// interpolated into ORDER BY, an identifier position that bound
// parameters can't cover.

import { db } from "../fixtures/db.js";

export async function listLogs(sortColumn: string): Promise<unknown[]> {
  const sql = `SELECT * FROM logs ORDER BY ${sortColumn} DESC`;
  return db.query(sql);
}
