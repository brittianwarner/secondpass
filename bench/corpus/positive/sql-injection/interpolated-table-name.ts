// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: sql-injection
// The report name doubles as the table name, interpolated straight into
// the FROM clause. Identifier positions can never be parameterized with
// bound params, so this needs an allowlist — there isn't one.

import { db } from "../fixtures/db.js";

export async function runAdHocReport(reportTable: string): Promise<unknown[]> {
  const sql = `SELECT * FROM ${reportTable} LIMIT 500`;
  return db.query(sql);
}
