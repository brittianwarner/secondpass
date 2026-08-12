// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: test-header-bypass
// An `ALLOW_INSECURE_*` environment flag read at runtime — the same
// class of control-weakening switch as a disable/skip/bypass flag, and
// just as exposed to accidental production misconfiguration.

export function shouldVerifyTls(): boolean {
  const insecureMode = process.env.ALLOW_INSECURE_TLS === "1";
  return !insecureMode;
}
