// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: auth-bypass
// The handler trusts a role claim the caller sent in the request body
// instead of reading it off the authenticated session. Any client can
// set isAdmin: true on the payload and provision themselves.

import type { Context } from "../fixtures/http.js";

interface ProvisionUserBody {
  email: string;
  isAdmin?: boolean;
}

export async function provisionUserHandler(c: Context<ProvisionUserBody>): Promise<Response> {
  const body = c.body;

  if (req.body.isAdmin) {
    await grantAdminRole(body.email);
  }

  return c.json({ email: body.email, provisioned: true });
}

declare const req: { body: ProvisionUserBody };

async function grantAdminRole(email: string): Promise<void> {
  void email;
}
