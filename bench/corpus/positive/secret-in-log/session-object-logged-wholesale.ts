// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: secret-in-log
// The entire session object — including its signed cookie value and
// bearer token — is logged wholesale for "debugging".

export async function traceRequest(session: { token: string; userId: string }): Promise<void> {
  console.log(session);
  await recordTrace(session.userId);
}

async function recordTrace(userId: string): Promise<void> {
  void userId;
}
