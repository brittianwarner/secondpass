// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): sql-injection
// The report table is interpolated too, but only after it is checked
// against a fixed allowlist — the exact identifier-position problem
// interpolated-table-name.ts has, minus the actual vulnerability.

import { db } from "../fixtures/db.js";

const ALLOWED_REPORT_TABLES = new Set(["daily_events", "weekly_events"]);

export async function runAdHocReport(reportTable: string): Promise<unknown[]> {
  if (!ALLOWED_REPORT_TABLES.has(reportTable)) {
    throw new Error("unknown report table");
  }

  const sql = `SELECT * FROM ${reportTable} LIMIT 500`;
  return db.query(sql);
}
