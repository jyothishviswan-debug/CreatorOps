import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext, ScopeGrant } from "@/server/authz/types";
import { getPartnerDocsByRefs } from "@/server/partners/firestore";
import { isPartnerDocInScope } from "@/server/partners/partners-gate";
import { getVendorDocsByRefs } from "@/server/vendors/firestore";
import { isVendorDocInScope } from "@/server/vendors/vendors-gate";

import { toInvoiceRowDto, type InvoiceWorkspaceDto } from "./client-dto";
import { listInvoiceHeadDocs, type InvoiceHeadListCursor } from "./firestore";
import { requireAmountsSensitiveAccess, requireFinanceInvoicesAccess } from "./finance-invoices-gate";
import { computeInvoicePermissions } from "./invoice-permissions";
import { financeInvoicesInvalidInputResult, financeInvoicesUnauthorizedResult, listInvoicesQuerySchema, DEFAULT_INVOICE_PAGE_SIZE, type FinanceInvoicesServiceResult, type InvoiceHeadDoc, type ListInvoicesQuery } from "./types";

// Step 16A: the trusted read behind the Finance Invoices WORKSPACE (GET /api/finance/invoices).
// Trust chain, index model and disclosure shape are identical to Payables' own
// payable-workspace-service.ts (see its own comment for the full reasoning) - scope-first bounded
// head scan, LIVE Partner/Vendor re-verification, in-memory business filters, deterministic order,
// deterministic offset cursor.

export const INVOICE_HEAD_SCAN_PAGE = 100;
export const INVOICE_HEAD_SCAN_CEILING = 500;

export type InvoiceWorkspaceOptions = { headCeiling?: number };
export type InvoiceScopeContext = { actorUid: string; grants: ScopeGrant[]; hasGlobal: boolean };

export async function scanInvoiceHeads(scope: InvoiceScopeContext, ceiling: number = INVOICE_HEAD_SCAN_CEILING): Promise<{ heads: InvoiceHeadDoc[]; truncated: boolean }> {
  const heads: InvoiceHeadDoc[] = [];
  let cursor: InvoiceHeadListCursor | undefined;
  for (;;) {
    const page = await listInvoiceHeadDocs({ limit: INVOICE_HEAD_SCAN_PAGE, cursor, actorUid: scope.actorUid, grants: scope.grants, hasGlobal: scope.hasGlobal });
    for (const head of page.heads) {
      if (heads.length >= ceiling) return { heads, truncated: true };
      heads.push(head);
    }
    if (!page.nextCursor) return { heads, truncated: false };
    cursor = page.nextCursor;
  }
}

export async function verifyLiveInvoiceCounterparties(scope: InvoiceScopeContext, heads: InvoiceHeadDoc[]): Promise<Array<{ head: InvoiceHeadDoc; liveName: string }>> {
  const partnerRefs = heads.filter((head) => head.counterpartyType === "PARTNER").map((head) => head.counterpartyRef);
  const vendorRefs = heads.filter((head) => head.counterpartyType === "VENDOR").map((head) => head.counterpartyRef);
  const [partners, vendors] = await Promise.all([partnerRefs.length > 0 ? getPartnerDocsByRefs(partnerRefs) : Promise.resolve(new Map()), vendorRefs.length > 0 ? getVendorDocsByRefs(vendorRefs) : Promise.resolve(new Map())]);

  const visible: Array<{ head: InvoiceHeadDoc; liveName: string }> = [];
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

export function matchesInvoiceFilters(head: InvoiceHeadDoc, query: ListInvoicesQuery): boolean {
  if (query.status !== undefined && head.status !== query.status) return false;
  if (query.counterpartyType !== undefined && head.counterpartyType !== query.counterpartyType) return false;
  if (query.counterpartyRef !== undefined && head.counterpartyRef !== query.counterpartyRef) return false;
  if (query.commercialPeriod !== undefined && head.periodKey !== query.commercialPeriod) return false;
  if (query.reconciliationState !== undefined && head.display.reconciliationState !== query.reconciliationState) return false;
  return true;
}

export function compareInvoiceHeads(a: InvoiceHeadDoc, b: InvoiceHeadDoc): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
  if (a.periodKey !== b.periodKey) return b.periodKey.localeCompare(a.periodKey);
  return a.invoiceRef.localeCompare(b.invoiceRef);
}

export function encodeInvoiceCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function decodeInvoiceCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    return typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

export async function listInvoicesWorkspace(actor: ActorContext | null, rawQuery: unknown, options: InvoiceWorkspaceOptions = {}): Promise<FinanceInvoicesServiceResult<InvoiceWorkspaceDto>> {
  const access = await requireFinanceInvoicesAccess(actor);
  if (!access.ok) return financeInvoicesUnauthorizedResult(access.reason);

  const parsed = listInvoicesQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) return financeInvoicesInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const query = parsed.data;
  const pageSize = query.limit ?? DEFAULT_INVOICE_PAGE_SIZE;
  const ceiling = options.headCeiling !== undefined && Number.isInteger(options.headCeiling) && options.headCeiling >= 1 ? options.headCeiling : INVOICE_HEAD_SCAN_CEILING;

  const grants = await getActorScopeGrants(actor!);
  const scope: InvoiceScopeContext = { actorUid: actor!.uid, grants, hasGlobal: hasGlobalScope(grants) };

  const [permissions, amounts, scan] = await Promise.all([computeInvoicePermissions(actor), requireAmountsSensitiveAccess(actor!), scanInvoiceHeads(scope, ceiling)]);
  const verified = await verifyLiveInvoiceCounterparties(scope, scan.heads);
  const matching = verified.filter(({ head }) => matchesInvoiceFilters(head, query)).sort((a, b) => compareInvoiceHeads(a.head, b.head));

  const offset = decodeInvoiceCursor(query.cursor);
  const page = matching.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;

  const notices: string[] = [];
  if (scan.truncated) notices.push(`Showing the ${scan.heads.length} most recently updated invoices in your scope. Narrow the filters to reach older ones.`);
  if (!amounts.ok) notices.push("Amounts are hidden: your role does not hold Finance amounts access.");

  return {
    ok: true,
    data: {
      rows: page.map(({ head, liveName }) => toInvoiceRowDto(head, liveName, { amountsVisible: amounts.ok })),
      nextCursor: nextOffset < matching.length ? encodeInvoiceCursor(nextOffset) : null,
      offset,
      pageSize,
      totalInBoundedSet: matching.length,
      disclosure: { headsRead: scan.heads.length, headsTruncated: scan.truncated, scanLimit: ceiling },
      notices,
      permissions,
    },
  };
}
