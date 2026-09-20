import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import type { ActorContext } from "@/server/authz/types";
import { NO_REVIEW_PERMISSIONS, type ReviewActionPermissions } from "./ui-dto";

// Step 13B: the server-computed action booleans the UI mirrors. They are the
// actor's own explicit grants for the `partner_reviews` feature - the SAME
// checks requirePartnerReviewsAccess applies on every mutation:
//   create                -> generate, refresh evidence, create revision
//   submit_partner_review -> submit for review
//   finalize_approve      -> finalize
// No role name, rank or wildcard is consulted. The booleans only decide whether
// a button is RENDERED; every mutation is re-authorized server-side (feature +
// action + live Partner scope), so a wrong or forged value can never grant
// anything.
export async function getReviewActionPermissions(actor: ActorContext | null): Promise<ReviewActionPermissions> {
  if (!actor) return NO_REVIEW_PERMISSIONS;
  if (!(await canAccessFeature(actor, "partner_reviews"))) return NO_REVIEW_PERMISSIONS;
  const [create, submit, finalize] = await Promise.all([
    canPerformAction(actor, "partner_reviews", "create"),
    canPerformAction(actor, "partner_reviews", "submit_partner_review"),
    canPerformAction(actor, "partner_reviews", "finalize_approve"),
  ]);
  return { canGenerate: create, canRefresh: create, canSubmit: submit, canFinalize: finalize, canCreateRevision: create };
}
