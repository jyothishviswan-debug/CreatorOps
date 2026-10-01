import { getUserDoc } from "@/server/authz/firestore";
import { getPartnerAccountDocByRef } from "@/server/partners/firestore";
import { isResearchComplete } from "./research";
import type { LeadDoc, ReadinessIssue, ReadinessResult } from "./types";

function blocker(code: string, message: string): ReadinessIssue {
  return { code, message };
}

// Step 6A section 9: readiness is derived, never a manually writable
// checkbox - it recomputes from the canonical Lead/evidence sources
// every time it's called, and this is the ONLY place that logic lives
// (the manual "mark conversion ready" transition and convertLead's own
// pre-flight both call this exact function, never a second
// reimplementation). Actor authorization/scope and current
// version/lifecycle are deliberately NOT checked here - those are the
// calling service's own pipeline stages, kept separate so this stays a
// pure function of the Lead's own recorded state (plus one live lookup:
// the assigned manager's current active status, since "valid ACTIVE
// manager assignment" can't be answered from data frozen on the Lead
// itself).
export async function evaluateLeadReadiness(lead: LeadDoc): Promise<ReadinessResult> {
  const blockers: ReadinessIssue[] = [];
  const warnings: ReadinessIssue[] = [];

  const hasContactMethod = Boolean(lead.email) || Boolean(lead.phone);
  if (!lead.displayName || !hasContactMethod) {
    blockers.push(blocker("IDENTITY_CONTACT_MISSING", "A display name and at least one contact method (email or phone) are required."));
  } else if (!lead.email || !lead.phone) {
    warnings.push({ code: "SINGLE_CONTACT_METHOD", message: "Only one contact method (email or phone) is on file." });
  }

  // Finding #26 (user-decided): a contact number is mandatory "from
  // Discovery itself" - creation already enforces this for every NEW Lead
  // (lead-service.ts's createLead), but a Lead created before that rule
  // existed can still be missing one. Rather than breaking reads/edits for
  // those old records, remediation is required at this progression
  // boundary instead - a Lead without a phone on file can never read as
  // conversion-ready until one is added.
  if (!lead.phone) {
    blockers.push(blocker("PHONE_MISSING", "A contact number is required before this Lead can proceed - add one on the Lead's own edit page."));
  }

  if (!isResearchComplete(lead.research)) {
    blockers.push(blocker("RESEARCH_INCOMPLETE", "Research is not complete - an approved Target Audience has not been recorded."));
  }

  if (!lead.latestReview || lead.latestReview.outcome !== "SHORTLIST") {
    blockers.push(blocker("REVIEW_MISSING", "This Lead has not been shortlisted through review."));
  }

  if (!lead.respondedAt) {
    blockers.push(blocker("RESPONSE_MISSING", "No meaningful response has been recorded for this Lead."));
  }
  if (!lead.commercial?.alignmentConfirmed) {
    blockers.push(blocker("COMMERCIAL_ALIGNMENT_MISSING", "Negotiation/commercial alignment has not been confirmed."));
  }

  if (!lead.discoveryAgreement?.confirmedAt) {
    blockers.push(blocker("OPERATIONAL_AGREEMENT_MISSING", "Operational Discovery agreement evidence has not been confirmed."));
  }

  if (!lead.assetDecision) {
    blockers.push(blocker("ASSET_DECISION_MISSING", "An asset decision has not been recorded."));
  } else if (lead.assetDecision.decision !== "NEW_ACCOUNT") {
    // Finding #15, evolved by finding #16 (user-decided): the old
    // invariant was "MAINTAIN/TRANSFER always requires
    // existingPartnerAccountRef." The new one is "MAINTAIN/TRANSFER
    // requires a real, identifiable account - EITHER a validated internal
    // ref OR sufficient confirmed external identity (this Lead's own
    // platform, captured on Profile essentials)" - never fabricated,
    // never fuzzy-matched. A present-but-inconsistent asset decision must
    // still block readiness, not just a wholly missing one -
    // saveAssetDecision no longer enforces a ref requirement at write
    // time (see its own comment), so this holistic check is now the ONLY
    // place both branches are actually verified before conversion.
    if (lead.assetDecision.existingPartnerAccountRef) {
      const account = await getPartnerAccountDocByRef(lead.assetDecision.existingPartnerAccountRef);
      if (!account) blockers.push(blocker("ASSET_DECISION_INVALID", "The asset decision references a Partner Account that no longer exists. Re-save the Asset Setup decision."));
    } else if (!lead.platform) {
      blockers.push(
        blocker(
          "ASSET_DECISION_INVALID",
          `The asset decision ("${lead.assetDecision.decision}") has neither a valid existing Partner Account reference nor confirmed external account identity (Platform) on this Lead. Add one before converting.`,
        ),
      );
    }
  }

  if (!lead.managerUid) {
    blockers.push(blocker("MANAGER_MISSING", "No manager has been assigned."));
  } else {
    const manager = await getUserDoc(lead.managerUid);
    if (!manager || !manager.active) {
      blockers.push(blocker("MANAGER_INACTIVE", "The assigned manager is no longer a real, active, admitted user."));
    }
  }

  if (!lead.kycPackageComplete) {
    blockers.push(blocker("KYC_INCOMPLETE", "The conversion-critical KYC package is incomplete."));
  }

  if (!lead.duplicateCheck || lead.duplicateCheck.status === "unknown") {
    blockers.push(blocker("DUPLICATE_UNRESOLVED", "Duplicate status is unknown - the automatic check either hasn't run yet or the last attempt failed."));
  } else if (lead.duplicateCheck.status === "confirmed") {
    blockers.push(blocker("DUPLICATE_CONFIRMED", "This Lead is a confirmed duplicate and must be resolved before conversion."));
  } else if (lead.duplicateCheck.status === "possible") {
    warnings.push({ code: "DUPLICATE_POSSIBLE", message: "A possible duplicate was found - review it before converting." });
  }

  return { ready: blockers.length === 0, blockers, warnings };
}
