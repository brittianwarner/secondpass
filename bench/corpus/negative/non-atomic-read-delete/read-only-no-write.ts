// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): non-atomic-read-delete
// A plain read with a fallback default — nothing is deleted, set, or
// written back afterward, so there's no race to have.

import { cache } from "../fixtures/cache.js";

export async function getCachedProfile(requestId: string): Promise<unknown> {
  const cachedValue = await cache.get(requestId);
  return cachedValue ?? computeDefaultProfile(requestId);
}

function computeDefaultProfile(requestId: string): unknown {
  return { requestId };
}
