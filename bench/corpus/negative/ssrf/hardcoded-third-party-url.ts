// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): ssrf
// A hardcoded, fully-literal URL to a known third party. No caller
// input reaches the request target at all.

import axios from "../fixtures/axios.js";

export async function listStripeChargesHandler(): Promise<unknown> {
  const response = await axios.get("https://api.stripe.com/v1/charges");
  return response.data;
}
