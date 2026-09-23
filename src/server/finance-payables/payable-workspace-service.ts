import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext, ScopeGrant } from "@/server/authz/types";
import { getPartnerDocsByRefs } from "@/server/partners/firestore";
import { isPartnerDocInScope } from "@/server/partners/partners-gate";
import { getVendorDocsByRefs } from "@/server/vendors/firestore";
import { isVendorDocInScope } from "@/server/vendors/vendors-gate";

import { toPayableRowDto, type PayableWorkspaceDto } from "./client-dto";
import { listPayableHeadDocs, type PayableHeadListCursor } from "./firestore";
import { requireAmountsSensitiveAccess, requireFinancePayablesAccess } from "./finance-payables-gate";
import { computePayablePermissions } from "./payable-permissions";
import { financePayablesInvalidInputResult, financePayablesUnauthorizedResult, listPayablesQuerySchema, DEFAULT_PAYABLE_PAGE_SIZE, type FinancePayablesServiceResult, type ListPayablesQuery, type PayableHeadDoc } from "./types";

// Step 15A: the trusted read behind the Finance Payables WORKSPACE (GET /api/finance/payables).
//
// Trust chain, identical in shape to the accepted Agreements workspace: Authentication ->
// Admission -> `finance` feature -> the actor's scope grants read ONCE -> SCOPE-FIRST bounded head
// scan (the scoped-list planner: SELF / REGION / TEAM / PARTNER-grant / explicit-vendor branches,
// or the global branch) -> each surfaced head's LIVE Partner / Vendor re-verified (the head's
// stored scope snapshot only decides what is READ, never what is SHOWN) -> in-memory business
// filters -> deterministic order -> deterministic offset cursor -> rows built from the head's
// stored `display` projection ("as of last update").
//
// Bounded and honest: at most PAYABLE_HEAD_SCAN_CEILING heads are read per request; when more
// exist in scope the response says so (`disclosure.headsTruncated`) and `totalInBoundedSet` is a
// LOWER BOUND, never presented as an exact total. Nothing is fetched by the browser and filtered
// there - every filter and the whole page are computed on the server.
//
// Why the business filters are in memory rather than pushed to Firestore: an in-memory filter that
// rejects raw documents would make a scoped-list page shorter than the limit look like the END of
// the list, and pushing them would multiply the composite index set. The bounded set is read once
// and paged deterministically in memory instead - exactly what the Agreements workspace does. The
// head nevertheless stores every filter dimension as a top-level indexable scalar, so a future
// step can push one without reshaping data.

export const PAYABLE_HEAD_SCAN_PAGE = 100;
export const PAYABLE_HEAD_SCAN_CEILING = 500;

export type PayableWorkspaceOptions = { headCeiling?: number };

export type PayableScopeContext = { actorUid: string; grants: ScopeGrant[]; hasGlobal: boolean };

export async function scanPayableHeads(scope: PayableScopeContext, ceiling: number = PAYABLE_HEAD_SCAN_CEILING): Promise<{ heads: PayableHeadDoc[]; truncated: boolean }> {
  const heads: PayableHeadDoc[] = [];
  let cursor: PayableHeadListCursor | undefined;
  for (;;) {
    const page = await listPayableHeadDocs({ limit: PAYABLE_HEAD_SCAN_PAGE, cursor, actorUid: scope.actorUid, grants: scope.grants, hasGlobal: scope.hasGlobal });
    for (const head of page.heads) {
      if (heads.length >= ceiling) return { heads, truncated: true };
      heads.push(head);
    }
    if (!page.nextCursor) return { heads, truncated: false };
    cursor = page.nextCursor;
  }
}

// The head's own scope snapshot is point-in-time; the LIVE Partner / Vendor is the authority. A
// head whose counterparty is missing, whose uid no longer matches, or which is out of the actor's
// live scope is dropped (bulk reads; grants read once).
export async function verifyLivePayableCounterparties(scope: PayableScopeContext, heads: PayableHeadDoc[]): Promise<Array<{ head: PayableHeadDoc; liveName: string }>> {
  const partnerRefs = heads.filter((head) => head.counterpartyType === "PARTNER").map((head) => head.counterpartyRef);
  const vendorRefs = heads.filter((head) => head.counterpartyType === "VENDOR").map((head) => head.counterpartyRef);
  const [partners, vendors] = await Promise.all([partnerRefs.length > 0 ? getPartnerDocsByRefs(partnerRefs) : Promise.resolve(new Map()), vendorRefs.length > 0 ? getVendorDocsByRefs(vendorRefs) : Promise.resolve(new Map())]);

  const visible: Array<{ head: PayableHeadDoc; liveName: string }> = [];
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

// Pure, so the filter contract is unit-testable without Firestore.
export function matchesPayableFilters(head: PayableHeadDoc, query: ListPayablesQuery): boolean {
  if (query.status !== undefined && head.status !== query.status) return false;
  if (query.counterpartyType !== undefined && head.counterpartyType !== query.counterpartyType) return false;
  if (query.counterpartyRef !== undefined && head.counterpartyRef !== query.counterpartyRef) return false;
  if (query.commercialPeriod !== undefined && head.periodKey !== query.commercialPeriod) return false;
  return true;
}

// Deterministic total order: newest update first, then the period, then the opaque ref - so the
// same bounded set always pages identically.
export function comparePayableHeads(a: PayableHeadDoc, b: PayableHeadDoc): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
  if (a.periodKey !== b.periodKey) return b.periodKey.localeCompare(a.periodKey);
  return a.payableRef.localeCompare(b.payableRef);
}

// The page cursor is a deterministic offset into that total order.
export function encodePayableCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function decodePayableCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    return typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

export async function listPayablesWorkspace(actor: ActorContext | null, rawQuery: unknown, options: PayableWorkspaceOptions = {}): Promise<FinancePayablesServiceResult<PayableWorkspaceDto>> {
  const access = await requireFinancePayablesAccess(actor);
  if (!access.ok) return financePayablesUnauthorizedResult(access.reason);

  const parsed = listPayablesQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) return financePayablesInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const query = parsed.data;
  const pageSize = query.limit ?? DEFAULT_PAYABLE_PAGE_SIZE;
  const ceiling = options.headCeiling !== undefined && Number.isInteger(options.headCeiling) && options.headCeiling >= 1 ? options.headCeiling : PAYABLE_HEAD_SCAN_CEILING;

  const grants = await getActorScopeGrants(actor!);
  const scope: PayableScopeContext = { actorUid: actor!.uid, grants, hasGlobal: hasGlobalScope(grants) };

  const [permissions, amounts, scan] = await Promise.all([computePayablePermissions(actor), requireAmountsSensitiveAccess(actor!), scanPayableHeads(scope, ceiling)]);
  const verified = await verifyLivePayableCounterparties(scope, scan.heads);
  const matching = verified.filter(({ head }) => matchesPayableFilters(head, query)).sort((a, b) => comparePayableHeads(a.head, b.head));

  const offset = decodePayableCursor(query.cursor);
  const page = matching.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;

  const notices: string[] = [];
  if (scan.truncated) notices.push(`Showing the ${scan.heads.length} most recently updated payables in your scope. Narrow the filters to reach older ones.`);
  if (!amounts.ok) notices.push("Amounts are hidden: your role does not hold Finance amounts access.");

  return {
    ok: true,
    data: {
      rows: page.map(({ head, liveName }) => toPayableRowDto(head, liveName, { amountsVisible: amounts.ok })),
      nextCursor: nextOffset < matching.length ? encodePayableCursor(nextOffset) : null,
      offset,
      pageSize,
      totalInBoundedSet: matching.length,
      disclosure: { headsRead: scan.heads.length, headsTruncated: scan.truncated, scanLimit: ceiling },
      notices,
      permissions,
    },
  };
}
