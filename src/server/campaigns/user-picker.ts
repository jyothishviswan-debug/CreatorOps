import { z } from "zod";

import { listUserDocs } from "@/server/authz/firestore";
import type { ActorContext } from "@/server/authz/types";
import { requireCampaignsAccess } from "./campaigns-gate";
import { campaignsInvalidInputResult, campaignsUnauthorizedResult, type CampaignsServiceResult } from "./types";

// Campaigns' own bounded owner-candidate search, gated by the SAME
// action (manage_campaign_ownership) that actually assigns the owner -
// mirrors Vendors'/Partners' own searchXOwnerCandidates exactly, over
// the same underlying users collection. Never a raw uid in the response.
export type CampaignOwnerCandidateDto = { userRef: string; displayName: string; email: string };

const searchInputSchema = z.object({
  emailPrefix: z.string().min(2).max(200),
  limit: z.number().int().min(1).max(20).optional(),
});
export type SearchCampaignOwnerCandidatesInput = z.input<typeof searchInputSchema>;

export async function searchCampaignOwnerCandidates(actor: ActorContext | null, rawInput: unknown): Promise<CampaignsServiceResult<CampaignOwnerCandidateDto[]>> {
  const gate = await requireCampaignsAccess(actor, "manage_campaign_ownership");
  if (!gate.ok) return campaignsUnauthorizedResult(gate.reason);

  const parsed = searchInputSchema.safeParse(rawInput);
  if (!parsed.success) return campaignsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const page = await listUserDocs({ limit: parsed.data.limit ?? 8, active: true, emailPrefix: parsed.data.emailPrefix.toLowerCase() });
  return { ok: true, data: page.users.map((user) => ({ userRef: user.userRef, displayName: user.displayName, email: user.email })) };
}
