// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): secret-in-log
// The comment literally shows the old, broken call as a warning. The
// real call below logs a boolean presence flag, never the key itself.

import { logger } from "../fixtures/logger.js";

export async function callProvider(apiKey: string, payload: unknown): Promise<unknown> {
  // TODO: stop calling logger.info({ apiKey }, "debug") in prod — LAY-991
  logger.info({ hasApiKey: Boolean(apiKey) }, "calling provider");
  return dispatch(apiKey, payload);
}

async function dispatch(apiKey: string, payload: unknown): Promise<unknown> {
  void apiKey;
  return payload;
}
