// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): secret-in-log
// The credential is passed through a redaction helper that returns a
// summary object with unrelated field names — nothing secret-shaped
// ever reaches the logger call's own argument list.

import { logger } from "../fixtures/logger.js";
import { redactSecrets } from "../fixtures/redact.js";

export async function callProvider(providerKey: string, payload: unknown): Promise<unknown> {
  logger.info(redactSecrets({ providerKey }), "calling provider");
  return dispatch(providerKey, payload);
}

async function dispatch(providerKey: string, payload: unknown): Promise<unknown> {
  void providerKey;
  return payload;
}
