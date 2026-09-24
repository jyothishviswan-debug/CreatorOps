import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext, ScopeGrant } from "@/server/authz/types";
import { getPartnerDocsByRefs } from "@/server/partners/firestore";
import { isPartnerDocInScope } from "@/server/partners/partners-gate";
import { getVendorDocsByRefs } from "@/server/vendors/firestore";
import { isVendorDocInScope } from "@/server/vendors/vendors-gate";

import { toPaymentRowDto, type PaymentWorkspaceDto } from "./client-dto";
import { listPaymentHeadDocs, listPaymentVersionDocs, type PaymentHeadListCursor } from "./firestore";
import { requireAmountsSensitiveAccess, requireFinancePaymentsAccess } from "./finance-payments-gate";
import { computePaymentPermissions } from "./payment-permissions";
import { financePaymentsInvalidInputResult, financePaymentsUnauthorizedResult, listPaymentsQuerySchema, DEFAULT_PAYMENT_PAGE_SIZE, type FinancePaymentsServiceResult, type ListPaymentsQuery, type PaymentHeadDoc } from "./types";

// Step 17A: the trusted read behind the Finance Payments WORKSPACE (GET /api/finance/payments).
// Trust chain, index model and disclosure shape are identical to Invoices'/Payables' own
// *-workspace-service.ts (see their own comments for the full reasoning) - scope-first bounded head
// scan, LIVE Partner/Vendor re-verification, in-memory business filters, deterministic order,
// deterministic offset cursor. Never fetches the entire Payments collection (section 18).

export const PAYMENT_HEAD_SCAN_PAGE = 100;
export const PAYMENT_HEAD_SCAN_CEILING = 500;

export type PaymentWorkspaceOptions = { headCeiling?: number };
export type PaymentScopeContext = { actorUid: string; grants: ScopeGrant[]; hasGlobal: boolean };

export async function scanPaymentHeads(scope: PaymentScopeContext, ceiling: number = PAYMENT_HEAD_SCAN_CEILING): Promise<{ heads: PaymentHeadDoc[]; truncated: boolean }> {
  const heads: PaymentHeadDoc[] = [];
  let cursor: PaymentHeadListCursor | undefined;
  for (;;) {
    const page = await listPaymentHeadDocs({ limit: PAYMENT_HEAD_SCAN_PAGE, cursor, actorUid: scope.actorUid, grants: scope.grants, hasGlobal: scope.hasGlobal });
    for (const head of page.heads) {
      if (heads.length >= ceiling) return { heads, truncated: true };
      heads.push(head);
    }
    if (!page.nextCursor) return { heads, truncated: false };
    cursor = page.nextCursor;
  }
}

export async function verifyLivePaymentCounterparties(scope: PaymentScopeContext, heads: PaymentHeadDoc[]): Promise<Array<{ head: PaymentHeadDoc; liveName: string }>> {
  const partnerRefs = heads.filter((head) => head.counterpartyType === "PARTNER").map((head) => head.counterpartyRef);
  const vendorRefs = heads.filter((head) => head.counterpartyType === "VENDOR").map((head) => head.counterpartyRef);
  const [partners, vendors] = await Promise.all([partnerRefs.length > 0 ? getPartnerDocsByRefs(partnerRefs) : Promise.resolve(new Map()), vendorRefs.length > 0 ? getVendorDocsByRefs(vendorRefs) : Promise.resolve(new Map())]);

  const visible: Array<{ head: PaymentHeadDoc; liveName: string }> = [];
  for (const head of heads) {
    if (head.counterpartyType === "PARTNER") {
      const partner = partners.get(head.counterpartyRef);
      if (partner && partner.uid === head.partnerUid && isPartnerDocInScope(scope.grants, scope.actorUid, partner)) visible.push({ head, liveName: partner.displayName });
    } else {
      const vendor = vendors.get(head.counterpartyRef);
      if (vendor && vendor.uid === head.vendorUid && isVendorDocInScope(scope.grants, scope.actorUid, vendor)) visible.push({ head, liveName: vendor.displayName });
    }
  }
  return visible;
}

export function matchesPaymentFilters(head: PaymentHeadDoc, query: ListPaymentsQuery): boolean {
  if (query.status !== undefined && head.status !== query.status) return false;
  if (query.invoiceRef !== undefined && head.invoiceRef !== query.invoiceRef) return false;
  if (query.counterpartyType !== undefined && head.counterpartyType !== query.counterpartyType) return false;
  if (query.counterpartyRef !== undefined && head.counterpartyRef !== query.counterpartyRef) return false;
  return true;
}

export function comparePaymentHeads(a: PaymentHeadDoc, b: PaymentHeadDoc): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
  return a.paymentRef.localeCompare(b.paymentRef);
}

export function encodePaymentCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function decodePaymentCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    return typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

export async function listPaymentsWorkspace(actor: ActorContext | null, rawQuery: unknown, options: PaymentWorkspaceOptions = {}): Promise<FinancePaymentsServiceResult<PaymentWorkspaceDto>> {
  const access = await requireFinancePaymentsAccess(actor);
  if (!access.ok) return financePaymentsUnauthorizedResult(access.reason);

  const parsed = listPaymentsQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) return financePaymentsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const query = parsed.data;
  const pageSize = query.limit ?? DEFAULT_PAYMENT_PAGE_SIZE;
  const ceiling = options.headCeiling !== undefined && Number.isInteger(options.headCeiling) && options.headCeiling >= 1 ? options.headCeiling : PAYMENT_HEAD_SCAN_CEILING;

  const grants = await getActorScopeGrants(actor!);
  const scope: PaymentScopeContext = { actorUid: actor!.uid, grants, hasGlobal: hasGlobalScope(grants) };

  const [permissions, amounts, scan] = await Promise.all([computePaymentPermissions(actor), requireAmountsSensitiveAccess(actor!), scanPaymentHeads(scope, ceiling)]);
  const verified = await verifyLivePaymentCounterparties(scope, scan.heads);
  const matching = verified.filter(({ head }) => matchesPaymentFilters(head, query)).sort((a, b) => comparePaymentHeads(a.head, b.head));

  const offset = decodePaymentCursor(query.cursor);
  const page = matching.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;

  // The method is on the latest VERSION, not the head - one small bounded read per row on this page
  // only (never for the whole scanned set).
  const methods = await Promise.all(page.map(({ head }) => listPaymentVersionDocs(head.paymentRef, 1)));

  const notices: string[] = [];
  if (scan.truncated) notices.push(`Showing the ${scan.heads.length} most recently updated payments in your scope. Narrow the filters to reach older ones.`);
  if (!amounts.ok) notices.push("Amounts are hidden: your role does not hold Finance amounts access.");

  return {
    ok: true,
    data: {
      rows: page.map(({ head, liveName }, index) => toPaymentRowDto(head, liveName, methods[index]?.versions[0]?.method ?? null, { amountsVisible: amounts.ok })),
      nextCursor: nextOffset < matching.length ? encodePaymentCursor(nextOffset) : null,
      disclosure: { headsRead: scan.heads.length, headsTruncated: scan.truncated, scanLimit: ceiling },
      notices,
      permissions,
    },
  };
}
