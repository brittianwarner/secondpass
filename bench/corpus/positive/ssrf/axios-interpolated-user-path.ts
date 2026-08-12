// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: ssrf
// The path segment of an outbound request is taken directly from the
// query string and interpolated into the URL — a caller can supply
// `../../internal-admin` or an absolute URL depending on the client.

import axios from "../fixtures/axios.js";

export async function proxyDocsHandler(targetHost: string, userSuppliedPath: string): Promise<unknown> {
  const response = await axios.get(`${targetHost}/${userSuppliedPath}`);
  return response.data;
}
