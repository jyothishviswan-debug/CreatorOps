import { z } from "zod";

import { listUserDocs } from "@/server/authz/firestore";
import type { ActorContext } from "@/server/authz/types";
import { requireDiscoveryAccess } from "./discovery-gate";
import { discoveryInvalidInputResult, discoveryUnauthorizedResult, type DiscoveryServiceResult } from "./types";

// Step 6B: "Manager picker must use real active admitted users; never a
// free-text/checkbox substitute." Administration's own listUsers is
// gated behind manage_users (an Administration action a Discovery
// operator won't usually hold), so this is Discovery's own bounded
// search over the SAME underlying users collection, gated by the
// manage_manager_assignment action instead - the same action that
// actually assigns the manager. Returns a minimal, safe shape (never a
// raw uid) - just enough to pick a manager.
export type ManagerCandidateDto = { userRef: string; displayName: string; email: string };

const searchInputSchema = z.object({
  emailPrefix: z.string().min(2).max(200),
  limit: z.number().int().min(1).max(20).optional(),
});
export type SearchManagerCandidatesInput = z.input<typeof searchInputSchema>;

export async function searchManagerCandidates(actor: ActorContext | null, rawInput: unknown): Promise<DiscoveryServiceResult<ManagerCandidateDto[]>> {
  if (!actor) return discoveryUnauthorizedResult("not_authenticated");
  const gate = await requireDiscoveryAccess(actor, "manage_manager_assignment");
  if (!gate.ok) return discoveryUnauthorizedResult(gate.reason);

  const parsed = searchInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const page = await listUserDocs({ limit: parsed.data.limit ?? 8, active: true, emailPrefix: parsed.data.emailPrefix.toLowerCase() });
  return { ok: true, data: page.users.map((user) => ({ userRef: user.userRef, displayName: user.displayName, email: user.email })) };
}
