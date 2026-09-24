import type { ActorContext } from "@/server/authz/types";
import { listPayablesWorkspace } from "@/server/finance-payables";

import { buildApprovalItemRef } from "../../ids";
import type { ApprovalItemDto } from "../types";

// Step 18A section 6: the Finance Payables adapter. A Payable "needs a human Finance decision" is
// exactly determinationState === "FINANCE_REVIEW_REQUIRED" (src/server/finance-payables/
// amount-determination.ts / types.ts's own PAYABLE_REVIEW_CODES) - always on a DRAFT payable (a
// READY_FOR_INVOICE one has already cleared every review item).
//
// READ-ONLY in this step. Resolving one of these items is NOT one decision - it is whichever of a
// closed but non-trivial set of manual adjustments (addPayableAdjustment with a specific
// resolvesCode) or the dedicated confirmPayableTax action actually answers the named review code
// (see PAYABLE_REVIEW_CODES's own per-code comments: a narrative incentive, an unspecified advance
// application, a missing incentive-metric evidence value, an ambiguous threshold, a missing GST/TDS
// rate confirmation ...). Routing a generic "resolve" action here would mean re-implementing which
// of those responses is valid for which code - exactly the "duplicating domain rules" section 6
// forbids. The ONLY call this adapter makes into Payables is listPayablesWorkspace - a published,
// actor-gated, bounded, already-safe-DTO read (no Payables Firestore collection, gate, or write
// function is imported anywhere in this module - proved by operations-static.test.ts).
export const PAYABLES_APPROVAL_SCAN_LIMIT = 50;

export async function listPendingPayableApprovals(actor: ActorContext | null): Promise<{ items: ApprovalItemDto[]; scanned: number }> {
  const result = await listPayablesWorkspace(actor, { status: "DRAFT", limit: PAYABLES_APPROVAL_SCAN_LIMIT });
  if (!result.ok) return { items: [], scanned: 0 };

  const reviewRequired = result.data.rows.filter((row) => row.determinationState === "FINANCE_REVIEW_REQUIRED");
  const items: ApprovalItemDto[] = reviewRequired.map((row) => ({
    approvalItemRef: buildApprovalItemRef({ sourceModule: "finance_payables", sourceType: "PAYABLE", sourceRef: row.payableRef, sourceVersion: row.latestVersion, actionType: "RESOLVE_PAYABLE_FINANCE_REVIEW" }),
    sourceModule: "finance_payables",
    sourceType: "PAYABLE",
    sourceRef: row.payableRef,
    sourceVersion: row.latestVersion,
    actionType: "RESOLVE_PAYABLE_FINANCE_REVIEW",
    title: `Finance review needed - ${row.counterparty.displayName ?? row.counterparty.type} (${row.commercialPeriod})`,
    summary: `${row.openReviewCount} open review item(s) block this payable from becoming ready for invoicing.`,
    requestedBy: null,
    requestedByDisplayName: null,
    requestedAt: row.lastUpdatedAt,
    currentSourceStatus: row.status,
    allowedActions: [],
    safeDisplayData: { counterpartyDisplayName: row.counterparty.displayName, commercialPeriod: row.commercialPeriod, openReviewCount: row.openReviewCount, sourceType: row.sourceType },
  }));
  return { items, scanned: result.data.rows.length };
}
