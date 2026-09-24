import type { ActorContext } from "@/server/authz/types";
import { listInvoicesWorkspace } from "@/server/finance-invoices";

import { buildApprovalItemRef } from "../../ids";
import type { ApprovalItemDto } from "../types";

// Step 18A section 6: the Finance Invoices adapter. A pending Invoice decision is exactly status
// SUBMITTED (src/server/finance-invoices/types.ts's own INVOICE_LIFECYCLE_TRANSITIONS: APPROVED is
// reachable only from SUBMITTED). `reconciliationState` is carried through unchanged as read-only
// context (MISMATCH/REVIEW_REQUIRED/BLOCKED all still gate the real approveInvoice call inside
// Invoices itself - this projection never re-derives or duplicates that gate, only displays it).
//
// READ-ONLY in this step: an approve/reject decision needs its own governance-weight grant; an
// amount mismatch needs a separate, narrower override grant (with its own mandatory reason and
// finance_amounts requirement); a payee-identity mismatch needs yet another, distinct grant (see
// finance-invoices-gate.ts's own comment for the exact three). Which of those apply to a given SUBMITTED invoice is
// exactly the reconciliation/payee-mismatch state Invoices itself computes - collapsing all three
// into one generic "act" call here would mean re-deciding which one is even legal, the same
// "duplicating domain rules" section 6 forbids. The ONLY call this adapter makes into Invoices is
// listInvoicesWorkspace - a published, actor-gated, bounded, already-safe-DTO read (no Invoices
// Firestore collection, gate, or write function is imported anywhere in this module - proved by
// operations-static.test.ts).
export const INVOICES_APPROVAL_SCAN_LIMIT = 50;

export async function listPendingInvoiceApprovals(actor: ActorContext | null): Promise<{ items: ApprovalItemDto[]; scanned: number }> {
  const result = await listInvoicesWorkspace(actor, { status: "SUBMITTED", limit: INVOICES_APPROVAL_SCAN_LIMIT });
  if (!result.ok) return { items: [], scanned: 0 };

  const items: ApprovalItemDto[] = result.data.rows.map((row) => ({
    approvalItemRef: buildApprovalItemRef({ sourceModule: "finance_invoices", sourceType: "INVOICE", sourceRef: row.invoiceRef, sourceVersion: row.latestVersion, actionType: "APPROVE_OR_REJECT_INVOICE" }),
    sourceModule: "finance_invoices",
    sourceType: "INVOICE",
    sourceRef: row.invoiceRef,
    sourceVersion: row.latestVersion,
    actionType: "APPROVE_OR_REJECT_INVOICE",
    title: `Approve or reject invoice - ${row.counterparty.displayName ?? row.counterparty.type} (${row.commercialPeriod})`,
    summary: `Reconciliation: ${row.reconciliationState}. External invoice number: ${row.externalInvoiceNumber ?? "none declared"}.`,
    requestedBy: null,
    requestedAt: row.lastUpdatedAt,
    currentSourceStatus: row.status,
    allowedActions: [],
    safeDisplayData: { counterpartyDisplayName: row.counterparty.displayName, commercialPeriod: row.commercialPeriod, reconciliationState: row.reconciliationState, externalInvoiceNumber: row.externalInvoiceNumber },
  }));
  return { items, scanned: result.data.rows.length };
}
