import { getUserDocByRef } from "@/server/authz/firestore";

// Notes/Meetings Completion: a small, deliberate duplicate of
// src/server/operations/operations-gate.ts's own requireAdmittedActiveUser - Notes/Meetings' only
// cross-module dependency stays the explicit promotion call (promotion.ts); an ordinary "is this ref
// a real, active CreatorOps user" check for Meeting participants/action-item assignees does not
// justify importing the whole Operations gate module.
export type AdmittedActiveUserCheck = { ok: true; uid: string } | { ok: false };

export async function requireAdmittedActiveUser(userRef: string): Promise<AdmittedActiveUserCheck> {
  const user = await getUserDocByRef(userRef);
  if (!user || !user.active) return { ok: false };
  return { ok: true, uid: user.uid };
}
