import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext, ScopeGrant } from "@/server/authz/types";
import { getPartnerDocsByRefs } from "@/server/partners/firestore";
import { isPartnerDocInScope } from "@/server/partners/partners-gate";
import { getVendorDocsByRefs } from "@/server/vendors/firestore";
import { isVendorDocInScope } from "@/server/vendors/vendors-gate";

import { listAgreementHeadDocs, type AgreementHeadListCursor } from "./firestore";
import { requireFinanceAgreementsAccess } from "./finance-agreements-gate";
import { computeFinanceAgreementPermissions } from "./finance-permissions";
import { computeIdentityStatusBulk } from "./identity-status";
import type { AgreementKycComponents } from "./kyc-status-service";
import { financeAgreementsUnauthorizedResult, type AgreementHeadDoc, type CounterpartyType, type FinanceAgreementsServiceResult } from "./types";
import type { AgreementWorkspaceDto, AgreementWorkspaceRowDto, FinanceAgreementPermissionsDto } from "./workspace-dto";
import {
  compareWorkspaceHeads,
  currentVersionOf,
  decodeWorkspaceCursor,
  encodeWorkspaceCursor,
  isAwaitingActivation,
  matchesWorkspaceFilters,
  parseWorkspaceQuery,
  primaryActionHint,
  type WorkspaceCandidate,
} from "./workspace-model";

// Step 14B: the trusted read behind the Finance Agreements WORKSPACE (GET /api/finance/agreements/workspace).
//
// Trust chain: Authentication -> Admission -> `finance` feature -> the actor's scope grants read ONCE -> SCOPE-FIRST bounded
// head scan (the scoped-list planner: SELF / REGION / TEAM / PARTNER-grant / explicit-vendor branches, or the global branch)
// -> each surfaced head's LIVE Partner / Vendor re-verified (the head's stored scope snapshot only decides what is READ, never
// what is SHOWN) -> in-memory filters -> deterministic order -> opaque offset cursor -> rows built from the head's stored
// `display` projection ("as of last update") plus ONE bulk KYC-status read for the page.
//
// Bounded and honest: at most AGREEMENT_HEAD_SCAN_CEILING heads are read per request; when more exist in scope the response
// says so (`disclosure.headsTruncated`) and `totalInBoundedSet` is then a LOWER BOUND, never presented as an exact total.
// Why not the scoped-list cursor for the page itself: an in-memory filter that rejects raw documents would make a page shorter
// than the limit look like the END of the list. The bounded set is read once and paged in memory instead.
//
// Nothing here is authorization truth for a mutation: the detail page and every command re-check the LIVE scope.

export const AGREEMENT_HEAD_SCAN_PAGE = 100;
// Ceiling on heads read for one workspace request.
export const AGREEMENT_HEAD_SCAN_CEILING = 500;

export type WorkspaceReadOptions = {
  // Test seams only: production callers omit both and get the production ceiling and the real clock.
  headCeiling?: number;
  now?: () => Date;
};

export type ScopeContext = { actorUid: string; grants: ScopeGrant[]; hasGlobal: boolean };

// Scope-first, bounded read of Agreement heads (newest first). Mirrors partner-reviews' scanHeads.
export async function scanAgreementHeads(scope: ScopeContext, ceiling: number = AGREEMENT_HEAD_SCAN_CEILING): Promise<{ heads: AgreementHeadDoc[]; truncated: boolean }> {
  const heads: AgreementHeadDoc[] = [];
  let cursor: AgreementHeadListCursor | undefined;
  for (;;) {
    const page = await listAgreementHeadDocs({ limit: AGREEMENT_HEAD_SCAN_PAGE, cursor, actorUid: scope.actorUid, grants: scope.grants, hasGlobal: scope.hasGlobal });
    for (const head of page.heads) {
      if (heads.length >= ceiling) return { heads, truncated: true };
      heads.push(head);
    }
    if (!page.nextCursor) return { heads, truncated: false };
    cursor = page.nextCursor;
  }
}

// The head's own scope snapshot is point-in-time; the LIVE Partner / Vendor is the authority. A head whose counterparty is
// missing, whose uid no longer matches, or which is out of the actor's live scope is dropped (bulk reads, grants read once).
export async function verifyLiveCounterparties(scope: ScopeContext, heads: AgreementHeadDoc[]): Promise<Array<{ head: AgreementHeadDoc; liveName: string }>> {
  const partnerRefs: string[] = [];
  const vendorRefs: string[] = [];
  for (const head of heads) (head.counterparty.type === "PARTNER" ? partnerRefs : vendorRefs).push(head.counterparty.type === "PARTNER" ? head.counterparty.partnerRef : head.counterparty.vendorRef);
  const [partners, vendors] = await Promise.all([partnerRefs.length > 0 ? getPartnerDocsByRefs(partnerRefs) : Promise.resolve(new Map()), vendorRefs.length > 0 ? getVendorDocsByRefs(vendorRefs) : Promise.resolve(new Map())]);

  const visible: Array<{ head: AgreementHeadDoc; liveName: string }> = [];
  for (const head of heads) {
    if (head.counterparty.type === "PARTNER") {
      const partner = partners.get(head.counterparty.partnerRef);
      if (partner && partner.uid === head.partnerUid && isPartnerDocInScope(scope.grants, scope.actorUid, partner)) visible.push({ head, liveName: partner.displayName });
    } else {
      const vendor = vendors.get(head.counterparty.vendorRef);
      if (vendor && vendor.uid === head.vendorUid && isVendorDocInScope(scope.grants, scope.actorUid, vendor)) visible.push({ head, liveName: vendor.displayName });
    }
  }
  return visible;
}

const RESTRICTED_COMPONENTS: AgreementKycComponents = { pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" };

function subjectUidOf(head: AgreementHeadDoc): string {
  return (head.counterparty.type === "PARTNER" ? head.partnerUid : head.vendorUid) ?? "";
}

// Rows for ONE page: the head's stored display projection + live name + one bulk KYC-status read. KYC `state` is visible to any
// actor authorized for the Agreement; per-component detail only with the counterparty type's identity category.
async function buildRows(page: WorkspaceCandidate[], permissions: FinanceAgreementPermissionsDto): Promise<AgreementWorkspaceRowDto[]> {
  const identity = await computeIdentityStatusBulk(page.map(({ head }) => ({ type: head.counterparty.type as CounterpartyType, uid: subjectUidOf(head) })));
  return page.map(({ head, liveName }) => {
    const type = head.counterparty.type;
    const display = head.display;
    const status = identity.get(`${type}:${subjectUidOf(head)}`);
    const detailVisible = permissions.byCounterpartyType[type].canViewIdentity;
    const unresolved = display?.unresolvedFieldCount ?? 0;
    return {
      agreementRef: head.agreementRef,
      counterparty: {
        type,
        ref: head.counterparty.type === "PARTNER" ? head.counterparty.partnerRef : head.counterparty.vendorRef,
        displayName: liveName,
        platformScope: head.counterparty.type === "PARTNER" ? [...head.counterparty.platformScope] : [],
      },
      currentVersion: currentVersionOf(head),
      openVersion: head.openVersion,
      lifecycle: head.status,
      awaitingActivation: isAwaitingActivation(head),
      agreementNumber: display?.agreementNumber ?? null,
      agreementType: display?.agreementType ?? null,
      effectiveFrom: display?.effectiveFrom ?? null,
      effectiveTo: display?.effectiveTo ?? null,
      sourceMode: display?.sourceMode ?? null,
      kyc: { state: status?.state ?? "UNAVAILABLE", components: detailVisible && status ? { ...status.components } : { ...RESTRICTED_COMPONENTS } },
      extractionStatus: display?.extractionStatus ?? null,
      unresolvedFieldCount: unresolved,
      hasDiscrepancy: unresolved > 0,
      lastUpdatedAt: head.updatedAt,
      primaryAction: primaryActionHint(head, permissions),
    };
  });
}

// Chain: Authentication -> Admission -> FeatureAccess(finance) -> scope grants -> scoped bounded scan -> live counterparty
// re-verification -> filters -> order -> page. Requires no action grant (read gate); an out-of-scope Agreement never appears.
export async function listAgreementsWorkspace(actor: ActorContext | null, rawQuery: unknown, options: WorkspaceReadOptions = {}): Promise<FinanceAgreementsServiceResult<AgreementWorkspaceDto>> {
  const access = await requireFinanceAgreementsAccess(actor);
  if (!access.ok) return financeAgreementsUnauthorizedResult(access.reason);

  const { query, ignoredFilters } = parseWorkspaceQuery(rawQuery);
  const now = options.now?.() ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const ceiling = options.headCeiling !== undefined && Number.isInteger(options.headCeiling) && options.headCeiling >= 1 ? options.headCeiling : AGREEMENT_HEAD_SCAN_CEILING;

  const grants = await getActorScopeGrants(actor!);
  const scope: ScopeContext = { actorUid: actor!.uid, grants, hasGlobal: hasGlobalScope(grants) };

  const [permissions, scan] = await Promise.all([computeFinanceAgreementPermissions(actor, null), scanAgreementHeads(scope, ceiling)]);
  const verified = await verifyLiveCounterparties(scope, scan.heads);
  const matching = verified.filter((candidate) => matchesWorkspaceFilters(candidate, query, today)).sort((a, b) => compareWorkspaceHeads(a.head, b.head));

  const offset = decodeWorkspaceCursor(query.cursor);
  const pageSize = query.limit;
  const pageCandidates = matching.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;

  const notices: string[] = [];
  if (ignoredFilters.length > 0) notices.push("Some filters were not valid and were ignored.");
  if (scan.truncated) notices.push(`Showing the ${scan.heads.length} most recently updated Agreements in your scope. Narrow the filters to reach older ones.`);

  return {
    ok: true,
    data: {
      rows: await buildRows(pageCandidates, permissions),
      nextCursor: nextOffset < matching.length ? encodeWorkspaceCursor(nextOffset) : null,
      offset,
      pageSize,
      totalInBoundedSet: matching.length,
      disclosure: { headsRead: scan.heads.length, headsTruncated: scan.truncated, scanLimit: ceiling },
      notices,
      permissions,
    },
  };
}
