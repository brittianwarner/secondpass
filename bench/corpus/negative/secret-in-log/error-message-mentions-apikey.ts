// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): secret-in-log
// The word "apiKey" appears in a human-readable error message string —
// no actual key value is ever passed to the logger.

import { logger } from "../fixtures/logger.js";

export async function refreshCredentials(context: Record<string, unknown>): Promise<void> {
  try {
    await rotateKey();
  } catch (err) {
    logger.error(new Error("Failed to refresh apiKey"), context);
    throw err;
  }
}

async function rotateKey(): Promise<void> {}
