import { z } from "zod";

import { listUserDocs } from "@/server/authz/firestore";
import type { ActorContext } from "@/server/authz/types";
import { requireVendorsAccess } from "./vendors-gate";
import { vendorsInvalidInputResult, vendorsUnauthorizedResult, type VendorsServiceResult } from "./types";

// Vendors' own bounded owner-candidate search, gated by the SAME action
// (manage_vendor_ownership) that actually assigns the owner - mirrors
// Partners' searchPartnerOwnerCandidates exactly, over the same
// underlying users collection. Never a raw uid in the response.
export type VendorOwnerCandidateDto = { userRef: string; displayName: string; email: string };

const searchInputSchema = z.object({
  emailPrefix: z.string().min(2).max(200),
  limit: z.number().int().min(1).max(20).optional(),
});
export type SearchVendorOwnerCandidatesInput = z.input<typeof searchInputSchema>;

export async function searchVendorOwnerCandidates(actor: ActorContext | null, rawInput: unknown): Promise<VendorsServiceResult<VendorOwnerCandidateDto[]>> {
  const gate = await requireVendorsAccess(actor, "manage_vendor_ownership");
  if (!gate.ok) return vendorsUnauthorizedResult(gate.reason);

  const parsed = searchInputSchema.safeParse(rawInput);
  if (!parsed.success) return vendorsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const page = await listUserDocs({ limit: parsed.data.limit ?? 8, active: true, emailPrefix: parsed.data.emailPrefix.toLowerCase() });
  return { ok: true, data: page.users.map((user) => ({ userRef: user.userRef, displayName: user.displayName, email: user.email })) };
}
