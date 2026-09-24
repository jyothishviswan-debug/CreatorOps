import type { ActorContext } from "@/server/authz/types";

import { requireOperationsAccess } from "../operations-gate";
import { operationsInvalidInputResult, operationsNotFoundResult, operationsUnauthorizedResult, type OperationsServiceResult } from "../types";
import { listPendingInvoiceApprovals } from "./adapters/invoices-adapter";
import { listPendingPartnerReviewApprovals } from "./adapters/partner-reviews-adapter";
import { listPendingPayableApprovals } from "./adapters/payables-adapter";
import { listPendingPaymentApprovals } from "./adapters/payments-adapter";
import { approvalSourceModuleSchema, type ApprovalItemDto, type ApprovalQueueListDto } from "./types";

// Step 18A section 6: the Approval Queue service - a DERIVED READ MODEL over four authoritative
// modules' own pending-decision state, built fresh on every call from their own published,
// actor-gated, bounded list functions (see ./adapters/*). There is no Firestore collection behind
// this file, no persisted "approval status" of any kind, and no write anywhere in this file or its
// adapters - `listApprovalQueue`/`getApprovalItem`/`refreshApprovalItem` are the entire surface.
//
// Why every item is READ-ONLY in Step 18A (the addendum's own required design call, made explicit
// here rather than only in the completion report): each of the four candidate "act on it" actions
// (finalize a Partner Review, resolve a Payable's named review code, approve/reject or resolve a
// mismatch on an Invoice, confirm a Payment) either (a) needs domain-specific input this generic
// queue has no safe way to collect (which PAYABLE_REVIEW_CODE is being resolved, and with what
// adjustment), or (b) is concurrency-critical in a way that must stay inside the SOURCE module's own
// transaction (a Payment confirm reads the settlement accumulator atomically - see the payments
// adapter's own comment), or (c) both. Routing any of them here would mean re-implementing that
// module's own domain rule or duplicating its own concurrency-critical read outside the transaction
// that protects it - exactly what section 6 forbids ("if safe action-routing... can't be done
// without duplicating domain rules... stays READ-ONLY"). So: every item in Step 18A is READ-ONLY.
// `allowedActions` on every ApprovalItemDto is always `[]`; there is no `act_on_approval_queue`
// action anywhere in this codebase (see authz/actions.ts's own comment) and no generic "act" or
// "setStatus" function anywhere in this file. Step 18B is where a deep-link into the source
// module's own existing UI/route belongs - this queue's job in 18A is to surface WHAT is pending and
// WHERE, safely, nothing more.

export const APPROVAL_QUEUE_SCAN_NOTICE = "Approval Queue items are a live, read-only projection of each source module's own pending decisions. Act on an item from its own module.";

async function listAllPending(actor: ActorContext | null): Promise<ApprovalQueueListDto> {
  const [reviews, payables, invoices, payments] = await Promise.all([listPendingPartnerReviewApprovals(actor), listPendingPayableApprovals(actor), listPendingInvoiceApprovals(actor), listPendingPaymentApprovals(actor)]);
  return {
    items: [...reviews.items, ...payables.items, ...invoices.items, ...payments.items],
    scanned: { partnerReviews: reviews.scanned, payables: payables.scanned, invoices: invoices.scanned, payments: payments.scanned },
    notices: [APPROVAL_QUEUE_SCAN_NOTICE],
  };
}

export type ListApprovalQueueQuery = { sourceModule?: string; limit?: number };

export async function listApprovalQueue(actor: ActorContext | null, rawQuery: unknown): Promise<OperationsServiceResult<ApprovalQueueListDto>> {
  const access = await requireOperationsAccess(actor, "view_approval_queue");
  if (!access.ok) return operationsUnauthorizedResult(access.reason);

  const query = (rawQuery ?? {}) as Record<string, unknown>;
  let sourceModuleFilter: string | undefined;
  if (query.sourceModule !== undefined) {
    const parsed = approvalSourceModuleSchema.safeParse(query.sourceModule);
    if (!parsed.success) return operationsInvalidInputResult("Unknown sourceModule filter.");
    sourceModuleFilter = parsed.data;
  }
  let limit: number | undefined;
  if (query.limit !== undefined) {
    if (typeof query.limit !== "number" || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200) return operationsInvalidInputResult("limit must be an integer between 1 and 200.");
    limit = query.limit;
  }

  const all = await listAllPending(actor);
  const filtered = sourceModuleFilter ? all.items.filter((item) => item.sourceModule === sourceModuleFilter) : all.items;
  return { ok: true, data: { ...all, items: limit ? filtered.slice(0, limit) : filtered } };
}

// A single item's safe projection - re-derived from the SAME live source query as the list (this is
// deliberately NOT a Firestore doc get(); there is nothing to get()). A stale/unknown/foreign
// approvalItemRef is indistinguishable from "no longer pending" - both simply report not_found,
// exactly like every other module's own neutral-not-found discipline.
export async function getApprovalItem(actor: ActorContext | null, rawApprovalItemRef: unknown): Promise<OperationsServiceResult<ApprovalItemDto>> {
  const access = await requireOperationsAccess(actor, "view_approval_queue");
  if (!access.ok) return operationsUnauthorizedResult(access.reason);
  if (typeof rawApprovalItemRef !== "string" || rawApprovalItemRef.length === 0) return operationsNotFoundResult();

  const all = await listAllPending(actor);
  const found = all.items.find((item) => item.approvalItemRef === rawApprovalItemRef);
  if (!found) return operationsNotFoundResult();
  return { ok: true, data: found };
}

// "Refresh" is the same live re-derivation as `get` - there is no cached/stale copy anywhere to
// invalidate, which IS the point (section 6/13: "Approval projection refresh while source action
// changes" - a refresh always reflects the CURRENT source state, because it never reads anything
// but the current source state).
export const refreshApprovalItem = getApprovalItem;
