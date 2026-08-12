// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): ssrf
// A different HTTP client wrapper (not fetch/axios/got/undici), and the
// URL is resolved against a host allowlist before the request goes out.

import { httpClient } from "../fixtures/internal-http-client.js";
import { resolveAllowedHost } from "../fixtures/net.js";

export async function proxyDocsHandler(userSuppliedPath: string): Promise<unknown> {
  const resolvedInternalUrl = await resolveAllowedHost(userSuppliedPath);
  const response = await httpClient.get(resolvedInternalUrl);
  return response.data;
}
