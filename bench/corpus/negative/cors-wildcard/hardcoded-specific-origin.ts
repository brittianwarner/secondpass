// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): cors-wildcard
// A single, hardcoded, specific origin — not a wildcard, and not
// derived from anything the caller sent.

export const publicApiHeaders = {
  "Access-Control-Allow-Origin": "https://app.example.com",
  "Content-Type": "application/json",
};
