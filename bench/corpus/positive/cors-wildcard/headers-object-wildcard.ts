// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: cors-wildcard
// A plain headers object, built once and reused across every response,
// bakes the wildcard origin in at module scope.

export const publicApiHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};
