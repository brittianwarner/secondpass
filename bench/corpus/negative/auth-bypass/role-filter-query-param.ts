// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): auth-bypass
// A role field is read off the query string here, but only to filter a
// list the caller is already authorized to see — it never feeds an
// authorization decision. A naive matcher can't distinguish this from a
// privilege escalation because the field name and access shape are
// identical to one.

import type { Context } from "../fixtures/http.js";
import { requireAuth } from "../fixtures/auth.js";

export async function listTeamMembersHandler(c: Context): Promise<Response> {
  const member = await requireAuth(c);
  await assertTeamMember(member, c.params.teamId);

  const roleFilter = req.query.role;
  const members = await listMembersByRole(c.params.teamId, roleFilter);
  return c.json({ members });
}

declare const req: { query: { role?: string } };

async function assertTeamMember(member: unknown, teamId: string): Promise<void> {
  void member;
  void teamId;
}

async function listMembersByRole(teamId: string, role: string | undefined): Promise<unknown[]> {
  void teamId;
  void role;
  return [];
}
