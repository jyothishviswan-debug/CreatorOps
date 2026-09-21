import type { ActorContext } from "@/server/authz/types";
import { listPartnerDocs } from "@/server/partners/firestore";
import { narrowingRegions } from "@/server/shared/region-filter";

import { compareCandidates } from "./needs-review-candidates";
import { getReviewActionPermissions } from "./partner-review-permissions";
import { requirePartnerReviewsFeatureAccess } from "./partner-reviews-gate";
import { buildCandidateRow, buildReviewRow, rowMatchesSignal } from "./review-rows";
import { CANDIDATE_SCAN_CEILING, HEAD_SCAN_CEILING, resolveDisplays, scanHeads, verifyLiveScope, type ScopeContext } from "./review-scan";
import { loadScopeContext, loadViewContext } from "./review-view-context";
import { partnerReviewsUnauthorizedResult, type PartnerReviewHeadDoc, type PartnerReviewsServiceResult } from "./types";
import type { MonthResolutionDto, ReviewActionPermissions, ReviewListRowDto, ReviewScanDisclosureDto } from "./ui-dto";
import { MAX_WORKSPACE_PAGE_SIZE, type MonthParam, type WorkspaceFilter, type WorkspaceSignal } from "./ui-params";

// Step 13B: the trusted read behind the Partner Reviews Workspace (and its load-more API).
//
// Trust chain: `partner_reviews` feature -> actor scope grants read ONCE -> scope-first
// bounded head reads (accepted scoped-list machinery) -> each surfaced head's LIVE
// Partner re-verified -> rows built from stored list projections. The evidence
// collector and the freshness evaluator are never reached from here.
//
// Every mode is DETERMINISTIC and reads a BOUNDED set (at most HEAD_SCAN_CEILING reviews of the selected
// month, scope-first, each Partner re-verified live), sorted by Partner display name then partnerRef, and
// paged in memory with an opaque offset cursor:
//   needs-review   DERIVED, never persisted: reviews that were behind upstream at their LAST RECORDED
//                  freshness check + Partner-months with in-period Assignments but no review head yet
//                  (a bounded scan of the most recent Assignments - see review-scan.ts);
//   drafts         reviews with an open Draft / In Review version;
//   finalized      reviews with a current finalized version;
//   signal         a Needs Attention drill-down: reviews matching one signal from the stored summary.
// Why not the accepted scoped-list cursor for drafts/finalized: that machinery treats a page shorter than
// the limit as the END of the list, so an in-memory filter (open version / finalized / region) that rejects
// raw documents would silently truncate the list. Reading the month's bounded head set and filtering it
// server-side is correct and stays O(<= HEAD_SCAN_CEILING) head reads.

export type WorkspaceQuery = {
  month: MonthParam;
  filter: WorkspaceFilter | null;
  signal: WorkspaceSignal | null;
  partnerRef?: string;
  region: string[];
  cursor?: string;
  limit: number;
};

export type WorkspaceMode = WorkspaceFilter | "signal";

export type PartnerReviewsWorkspaceDto = {
  mode: WorkspaceMode;
  signal: WorkspaceSignal | null;
  month: MonthResolutionDto;
  rows: ReviewListRowDto[];
  nextCursor: string | null;
  // The exact size of the bounded, filtered result (the cursor pages over it). It is NOT the month's total when
  // `disclosure.headsTruncated` is true: reviews beyond the bounded head read are then unread, so this is a lower bound.
  totalInBoundedSet: number;
  partnerFilter: { partnerRef: string; displayName: string } | null;
  permissions: ReviewActionPermissions;
  disclosure: ReviewScanDisclosureDto;
  notices: string[];
};

// --- Opaque cursor ----------------------------------------------------------------------
type DecodedCursor = { offset: number } | null;

export function encodeCursor(value: { offset: number }): string {
  return Buffer.from(JSON.stringify({ o: value.offset }), "utf8").toString("base64url");
}

// A malformed / tampered cursor is dropped (the list simply starts over), never trusted.
export function decodeCursor(raw: string | undefined): DecodedCursor {
  if (!raw || raw.length > 200) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { o?: unknown };
    if (Number.isInteger(parsed.o) && (parsed.o as number) >= 0 && (parsed.o as number) <= 100_000) return { offset: parsed.o as number };
  } catch {
    // fall through
  }
  return null;
}

function compareRows(a: ReviewListRowDto, b: ReviewListRowDto): number {
  return compareCandidates({ periodKey: a.periodKey, partnerRef: a.partnerRef, name: (a.partnerDisplayName ?? "").toLowerCase() }, { periodKey: b.periodKey, partnerRef: b.partnerRef, name: (b.partnerDisplayName ?? "").toLowerCase() });
}

async function headRows(scope: ScopeContext, heads: PartnerReviewHeadDoc[]): Promise<ReviewListRowDto[]> {
  const live = await verifyLiveScope(scope, heads.map((head) => head.partnerRef));
  const visible = heads.filter((head) => live.has(head.partnerRef));
  const displays = await resolveDisplays(visible);
  return visible.map((head) => buildReviewRow(head, displays.get(head.reviewRef), live.get(head.partnerRef)?.displayName ?? null));
}

// `options.headCeiling` exists so tests can prove the bounded-read behaviour with a handful of fixtures; every real caller
// (the page and the load-more API) omits it and gets the production HEAD_SCAN_CEILING.
export type WorkspaceReadOptions = { headCeiling?: number };

export async function getPartnerReviewsWorkspace(actor: ActorContext | null, query: WorkspaceQuery, options: WorkspaceReadOptions = {}): Promise<PartnerReviewsServiceResult<PartnerReviewsWorkspaceDto>> {
  const gate = await requirePartnerReviewsFeatureAccess(actor);
  if (!gate.ok) return partnerReviewsUnauthorizedResult(gate.reason);

  const mode: WorkspaceMode = query.filter ?? (query.signal ? "signal" : "needs-review");
  const limit = Math.max(1, Math.min(query.limit, MAX_WORKSPACE_PAGE_SIZE));
  const notices: string[] = [];

  // The Partner filter is a canonical partnerRef; a ref that is unknown OR out of live scope is
  // dropped with ONE neutral notice - indistinguishable, and never a data source.
  const scope0 = await loadScopeContext(actor!);
  let partnerFilter: PartnerReviewsWorkspaceDto["partnerFilter"] = null;
  if (query.partnerRef) {
    const live = await verifyLiveScope(scope0, [query.partnerRef]);
    const partner = live.get(query.partnerRef);
    if (partner) partnerFilter = { partnerRef: partner.partnerRef, displayName: partner.displayName };
    else notices.push("The selected Partner is not available in your authorized scope, so the Partner filter was not applied.");
  }

  const context = await loadViewContext(actor!, query.month, { candidates: mode === "needs-review" ? "always" : "if_no_reviews", partnerRef: partnerFilter?.partnerRef });
  const { scope, months } = context;
  if (months.invalidRequested) notices.push("The requested month is not a valid YYYY-MM month, so the latest review month was used.");
  const permissions = await getReviewActionPermissions(actor);

  const base = { mode, signal: query.signal, month: months, partnerFilter, permissions, notices };
  const emptyDisclosure: ReviewScanDisclosureDto = { headsRead: 0, headsTruncated: false, assignmentsScanned: context.candidateScan?.scanned ?? null, assignmentScanTruncated: context.candidateScan?.truncated ?? false, scanLimit: CANDIDATE_SCAN_CEILING };
  if (!months.resolved) return { ok: true, data: { ...base, rows: [], nextCursor: null, totalInBoundedSet: 0, disclosure: emptyDisclosure } };

  const decoded = decodeCursor(query.cursor);
  // Choosing EVERY State/UT ("All regions") is no region filter (shared rule with the Analytics selector).
  const regions = narrowingRegions(query.region);
  const partnerScoped = partnerFilter ? { partnerRef: partnerFilter.partnerRef, partnerAuthorized: true } : {};

  // The month's reviews, scope-first and bounded. The Region narrowing is applied to the (already bounded)
  // set - never as a raw-document filter inside the scoped query.
  const headCeiling = options.headCeiling !== undefined && Number.isInteger(options.headCeiling) && options.headCeiling >= 1 ? options.headCeiling : HEAD_SCAN_CEILING;
  const scan = await scanHeads(scope, { periodKey: months.resolved, ceiling: headCeiling, ...partnerScoped });
  const scanned = regions.length > 0 ? scan.heads.filter((head) => head.regionIds.some((region) => regions.includes(region))) : scan.heads;
  let rows = await headRows(scope, scanned);

  if (query.signal) {
    rows = rows.filter((row) => rowMatchesSignal(row, query.signal!));
    if (mode === "drafts") rows = rows.filter((row) => row.lifecycle === "DRAFT" || row.lifecycle === "IN_REVIEW");
    else if (mode === "finalized") rows = rows.filter((row) => row.currentFinalizedVersion !== null);
    else if (mode === "needs-review") rows = rows.filter((row) => row.needsReviewReason !== null);
  } else if (mode === "drafts") {
    // An open Draft / In Review version (including a revision of a finalized review).
    rows = rows.filter((row) => row.lifecycle === "DRAFT" || row.lifecycle === "IN_REVIEW");
  } else if (mode === "finalized") {
    rows = rows.filter((row) => row.currentFinalizedVersion !== null);
  } else {
    // needs-review: reviews behind upstream (per the last recorded check) + Partner-months with no review yet.
    rows = rows.filter((row) => row.needsReviewReason !== null);
    const candidates = context.candidates
      .filter((candidate) => candidate.periodKey === months.resolved)
      .filter((candidate) => !partnerFilter || candidate.partnerRef === partnerFilter.partnerRef)
      .filter((candidate) => regions.length === 0 || candidate.partner.regionIds.some((region) => regions.includes(region)))
      .map((candidate) => buildCandidateRow(candidate, candidate.partner));
    rows = [...rows, ...candidates];
  }

  rows.sort(compareRows);
  const offset = decoded?.offset ?? 0;
  const pageRows = rows.slice(offset, offset + limit);
  const nextOffset = offset + limit;

  return {
    ok: true,
    data: {
      ...base,
      rows: pageRows,
      nextCursor: nextOffset < rows.length ? encodeCursor({ offset: nextOffset }) : null,
      totalInBoundedSet: rows.length,
      disclosure: { ...emptyDisclosure, headsRead: scan.heads.length, headsTruncated: scan.truncated },
    },
  };
}

// --- Partner search (Partner filter / selector) ----------------------------------------------------
export type ReviewPartnerSearchResult = { partners: { partnerRef: string; displayName: string; regions: string[] }[]; hasMore: boolean };

export const REVIEW_PARTNER_SEARCH_LIMIT = 10;

// Bounded, scope-FIRST Partner search by display-name prefix: the accepted scoped Partner
// list (the actor's own grants decide what it can reach BEFORE any document is read), so an
// out-of-scope Partner can never appear. Results are display identity only (canonical
// partnerRef, display name, region labels) - no email, phone, owner or legal name. Gated by the
// `partner_reviews` feature, exactly like the rest of this module.
export async function searchReviewPartners(actor: ActorContext | null, input: { q: string; limit?: number }): Promise<PartnerReviewsServiceResult<ReviewPartnerSearchResult>> {
  const gate = await requirePartnerReviewsFeatureAccess(actor);
  if (!gate.ok) return partnerReviewsUnauthorizedResult(gate.reason);

  const scope = await loadScopeContext(actor!);
  const limit = Math.max(1, Math.min(input.limit ?? REVIEW_PARTNER_SEARCH_LIMIT, REVIEW_PARTNER_SEARCH_LIMIT));
  const prefix = input.q.trim().toLowerCase();
  const page = await listPartnerDocs({
    limit,
    actorUid: scope.actorUid,
    grants: scope.grants,
    hasGlobal: scope.hasGlobal,
    displayNamePrefix: prefix.length > 0 ? prefix : undefined,
  });
  return {
    ok: true,
    data: { partners: page.partners.map((partner) => ({ partnerRef: partner.partnerRef, displayName: partner.displayName, regions: partner.regionIds })), hasMore: page.nextCursor !== null },
  };
}
