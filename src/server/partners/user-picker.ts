import { z } from "zod";

import { listUserDocs } from "@/server/authz/firestore";
import type { ActorContext } from "@/server/authz/types";
import { requirePartnersAccess } from "./partners-gate";
import { partnersInvalidInputResult, partnersUnauthorizedResult, type PartnersServiceResult } from "./types";

// Partners' own bounded owner-candidate search, gated by the SAME action
// (manage_partner_ownership) that actually assigns the owner - mirrors
// Discovery's manager picker/searchManagerCandidates exactly, over the
// same underlying users collection. Never a raw uid in the response.
export type PartnerOwnerCandidateDto = { userRef: string; displayName: string; email: string };

const searchInputSchema = z.object({
  emailPrefix: z.string().min(2).max(200),
  limit: z.number().int().min(1).max(20).optional(),
});
export type SearchPartnerOwnerCandidatesInput = z.input<typeof searchInputSchema>;

export async function searchPartnerOwnerCandidates(actor: ActorContext | null, rawInput: unknown): Promise<PartnersServiceResult<PartnerOwnerCandidateDto[]>> {
  const gate = await requirePartnersAccess(actor, "manage_partner_ownership");
  if (!gate.ok) return partnersUnauthorizedResult(gate.reason);

  const parsed = searchInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnersInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const page = await listUserDocs({ limit: parsed.data.limit ?? 8, active: true, emailPrefix: parsed.data.emailPrefix.toLowerCase() });
  return { ok: true, data: page.users.map((user) => ({ userRef: user.userRef, displayName: user.displayName, email: user.email })) };
}
