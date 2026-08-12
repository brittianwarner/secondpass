// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: secret-in-log
// The provider API key rides along in the structured log payload —
// it will land in every log sink, including ones with broader access
// than the secret store itself.

import { logger } from "../fixtures/logger.js";

export async function callProvider(apiKey: string, payload: unknown): Promise<unknown> {
  logger.info({ apiKey }, "calling provider");
  return dispatch(apiKey, payload);
}

async function dispatch(apiKey: string, payload: unknown): Promise<unknown> {
  void apiKey;
  return payload;
}
