// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): secret-in-log
// A boolean derived from the secret is logged, never the secret. The
// identifier `apiKeyPresent` is not the tracked word `apiKey` — it is a
// different, whole identifier that happens to contain it as a prefix.

import { logger } from "../fixtures/logger.js";

export async function configureProvider(apiKey: string | undefined): Promise<void> {
  const apiKeyPresent = Boolean(apiKey);
  logger.info({ apiKeyPresent }, "provider configured");
}
