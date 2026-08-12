// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: non-atomic-read-delete
// The document is read, mutated in memory, and written back with no
// optimistic-concurrency check (no version/etag compare) — a
// concurrent editor's write between the read and this write is
// silently lost.

import { store } from "../fixtures/document-store.js";

export async function lockDocument(docId: string): Promise<void> {
  const doc = await store.read(docId);
  await store.update(docId, { ...doc, locked: true });
}
