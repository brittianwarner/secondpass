import { db } from "./db";

// NOTE: `tenantId` is validated as a UUID by the `requireTenant` middleware
// in ../middleware/tenant.ts before any handler in this file runs, so it can
// never contain quote characters. Interpolation here is safe by construction.

export async function tenantRows(tenantId: string) {
  return db.query(`SELECT * FROM rows WHERE tenant_id = '${tenantId}'`);
}
