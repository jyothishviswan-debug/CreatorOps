import type { ActorContext } from "@/server/authz/types";
import { listPaymentsWorkspace } from "@/server/finance-payments";

import { buildApprovalItemRef } from "../../ids";
import type { ApprovalItemDto } from "../types";

// Step 18A section 6: the Finance Payments adapter. A pending Payment decision is exactly status
// RECORDED (src/server/finance-payments/types.ts's own PAYMENT_LIFECYCLE_TRANSITIONS: CONFIRMED is
// reachable only from RECORDED).
//
// READ-ONLY in this step: confirming needs its own governance-weight grant, and whether an overpayment override
// is even needed can only be known by attempting the real confirm transaction (it reads the
// settlement accumulator DOCUMENT inside that same transaction, atomically, against every other
// racing confirmation for the same invoice - see payment-lifecycle-service.ts's confirmPayment).
// Precomputing "would this overpay" here would mean a second, unsynchronized read of that same
// accumulator outside the transaction that actually protects it - a duplicate, driftable copy of
// exactly the concurrency-critical state section 6 exists to prevent Operations from ever creating.
// The ONLY call this adapter makes into Payments is listPaymentsWorkspace - a published, actor-
// gated, bounded, already-safe-DTO read (no Payments Firestore collection, gate, or write function
// is imported anywhere in this module - proved by operations-static.test.ts).
export const PAYMENTS_APPROVAL_SCAN_LIMIT = 50;

export async function listPendingPaymentApprovals(actor: ActorContext | null): Promise<{ items: ApprovalItemDto[]; scanned: number }> {
  const result = await listPaymentsWorkspace(actor, { status: "RECORDED", limit: PAYMENTS_APPROVAL_SCAN_LIMIT });
  if (!result.ok) return { items: [], scanned: 0 };

  const items: ApprovalItemDto[] = result.data.rows.map((row) => ({
    approvalItemRef: buildApprovalItemRef({ sourceModule: "finance_payments", sourceType: "PAYMENT", sourceRef: row.paymentRef, sourceVersion: row.latestVersion, actionType: "CONFIRM_PAYMENT" }),
    sourceModule: "finance_payments",
    sourceType: "PAYMENT",
    sourceRef: row.paymentRef,
    sourceVersion: row.latestVersion,
    actionType: "CONFIRM_PAYMENT",
    title: `Confirm payment - ${row.counterparty.displayName ?? row.counterparty.type}`,
    summary: `Recorded via ${row.method ?? "an unspecified method"}. Confirming will count it toward the invoice's settlement.`,
    requestedBy: null,
    requestedAt: row.lastUpdatedAt,
    currentSourceStatus: row.status,
    allowedActions: [],
    safeDisplayData: { counterpartyDisplayName: row.counterparty.displayName, method: row.method, invoiceRef: row.invoiceRef },
  }));
  return { items, scanned: result.data.rows.length };
}
