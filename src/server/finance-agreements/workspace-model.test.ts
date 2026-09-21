import { describe, expect, it } from "vitest";

import {
  compareWorkspaceHeads,
  currentVersionOf,
  decodeWorkspaceCursor,
  encodeWorkspaceCursor,
  matchesPeriodFilter,
  matchesWorkspaceFilters,
  parseWorkspaceQuery,
  primaryActionHint,
  WORKSPACE_DEFAULT_PAGE_SIZE,
  WORKSPACE_MAX_PAGE_SIZE,
  type WorkspaceCandidate,
} from "./workspace-model";
import { agreementHeadDocSchema, type AgreementHeadDoc } from "./types";
import type { AgreementWorkspaceQuery } from "./workspace-dto";

const NOW = "2026-03-10T00:00:00.000Z";
const TODAY = "2026-03-10";

function display(over: Record<string, unknown> = {}) {
  return { counterpartyName: "Acme Talent", counterpartyNameLower: "acme talent", agreementNumber: null, agreementType: null, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", sourceMode: "MANUAL", unresolvedFieldCount: 0, openVersionConfirmed: false, extractionStatus: null, governingStatus: "ACTIVE", projectedAt: NOW, ...over };
}

function head(over: Record<string, unknown> = {}): AgreementHeadDoc {
  return agreementHeadDocSchema.parse({
    agreementRef: "agr_00000000000000000001",
    docVersion: 1,
    counterparty: { type: "PARTNER", partnerRef: "p-ref", partnerAccountRefs: [], platformScope: ["instagram"] },
    partnerUid: "p-uid",
    status: "ACTIVE",
    latestVersion: 1,
    openVersion: null,
    activeVersion: 1,
    display: display(),
    createdAt: NOW,
    createdByUserRef: "u",
    updatedAt: NOW,
    updatedByUserRef: "u",
    ...over,
  });
}

const vendorHead = (over: Record<string, unknown> = {}) => head({ counterparty: { type: "VENDOR", vendorRef: "v-ref" }, partnerUid: null, vendorUid: "v-uid", ...over });
const candidate = (h: AgreementHeadDoc, liveName = "Acme Talent"): WorkspaceCandidate => ({ head: h, liveName });
const NO_FILTERS: AgreementWorkspaceQuery = { lifecycle: null, counterpartyType: null, q: null, platform: null, period: null, discrepancy: null, cursor: null, limit: 20 };
const q = (over: Partial<AgreementWorkspaceQuery>): AgreementWorkspaceQuery => ({ ...NO_FILTERS, ...over });

describe("parseWorkspaceQuery", () => {
  it("parses every documented param and defaults the rest", () => {
    expect(parseWorkspaceQuery({}).query).toEqual({ ...NO_FILTERS, limit: WORKSPACE_DEFAULT_PAGE_SIZE });
    const { query, ignoredFilters } = parseWorkspaceQuery({ lifecycle: "ACTIVE", counterpartyType: "VENDOR", q: "  acme ", platform: " YouTube ", period: "2026-03", discrepancy: "open", cursor: "abc", limit: "5" });
    expect(query).toEqual({ lifecycle: "ACTIVE", counterpartyType: "VENDOR", q: "acme", platform: "youtube", period: "2026-03", discrepancy: "open", cursor: "abc", limit: 5 });
    expect(ignoredFilters).toEqual([]);
    expect(parseWorkspaceQuery({ period: "current" }).query.period).toBe("current");
  });

  it("drops an unknown / malformed FILTER value (named in ignoredFilters) instead of widening or failing", () => {
    const { query, ignoredFilters } = parseWorkspaceQuery({ lifecycle: "SUPERSEDED", counterpartyType: "CREATOR", period: "2026-13", discrepancy: "all" });
    expect(query).toMatchObject({ lifecycle: null, counterpartyType: null, period: null, discrepancy: null });
    expect(ignoredFilters.sort()).toEqual(["counterpartyType", "discrepancy", "lifecycle", "period"]);
  });

  it("clamps the page size to 1..20, treats blank values as absent, bounds q and ignores non-string junk", () => {
    expect(parseWorkspaceQuery({ limit: 500 }).query.limit).toBe(WORKSPACE_MAX_PAGE_SIZE);
    expect(parseWorkspaceQuery({ limit: 0 }).query.limit).toBe(1);
    expect(parseWorkspaceQuery({ limit: "abc" }).query.limit).toBe(WORKSPACE_DEFAULT_PAGE_SIZE);
    expect(parseWorkspaceQuery({ limit: Number.NaN }).query.limit).toBe(WORKSPACE_DEFAULT_PAGE_SIZE);
    expect(parseWorkspaceQuery({ q: "   ", lifecycle: "" }).query).toMatchObject({ q: null, lifecycle: null });
    expect(parseWorkspaceQuery({ q: "x".repeat(300) }).query.q).toHaveLength(80);
    expect(parseWorkspaceQuery({ cursor: "c".repeat(400) }).query.cursor).toBeNull();
    expect(parseWorkspaceQuery({ q: { $ne: 1 }, lifecycle: ["ACTIVE"] }).query).toMatchObject({ q: null, lifecycle: null });
    expect(parseWorkspaceQuery(null).query).toEqual(NO_FILTERS);
  });
});

describe("opaque offset cursor", () => {
  it("round-trips an offset", () => {
    for (const offset of [0, 20, 480, 100_000]) expect(decodeWorkspaceCursor(encodeWorkspaceCursor(offset))).toBe(offset);
  });
  it("is opaque (not a plain number) and a malformed / tampered / oversized one restarts at 0, never throws", () => {
    expect(encodeWorkspaceCursor(40)).not.toContain("40");
    for (const bad of [null, undefined, "", "!!!", "eyJvIjotMX0", Buffer.from(JSON.stringify({ o: "x" })).toString("base64url"), Buffer.from(JSON.stringify({ o: 1.5 })).toString("base64url"), Buffer.from(JSON.stringify({ o: 1e9 })).toString("base64url"), "x".repeat(400)]) {
      expect(decodeWorkspaceCursor(bad as string | null | undefined)).toBe(0);
    }
  });
});

describe("matchesWorkspaceFilters", () => {
  it("no filter matches everything", () => {
    expect(matchesWorkspaceFilters(candidate(head()), NO_FILTERS, TODAY)).toBe(true);
  });

  it("lifecycle and counterparty type", () => {
    expect(matchesWorkspaceFilters(candidate(head()), q({ lifecycle: "ACTIVE" }), TODAY)).toBe(true);
    expect(matchesWorkspaceFilters(candidate(head()), q({ lifecycle: "DRAFT" }), TODAY)).toBe(false);
    expect(matchesWorkspaceFilters(candidate(head()), q({ counterpartyType: "VENDOR" }), TODAY)).toBe(false);
    expect(matchesWorkspaceFilters(candidate(vendorHead()), q({ counterpartyType: "VENDOR" }), TODAY)).toBe(true);
  });

  it("name search is a case-insensitive substring over the live name OR the stored snapshot (a renamed counterparty stays findable)", () => {
    expect(matchesWorkspaceFilters(candidate(head()), q({ q: "TALENT" }), TODAY)).toBe(true);
    expect(matchesWorkspaceFilters(candidate(head()), q({ q: "cme tal" }), TODAY)).toBe(true);
    expect(matchesWorkspaceFilters(candidate(head(), "Brand New Name"), q({ q: "brand new" }), TODAY)).toBe(true);
    expect(matchesWorkspaceFilters(candidate(head(), "Brand New Name"), q({ q: "acme" }), TODAY)).toBe(true);
    expect(matchesWorkspaceFilters(candidate(head(), "Brand New Name"), q({ q: "zzz" }), TODAY)).toBe(false);
    expect(matchesWorkspaceFilters(candidate(head({ display: null }), "Live Only"), q({ q: "live" }), TODAY)).toBe(true);
  });

  it("platform matches a Partner's platform scope only (a Vendor has none)", () => {
    expect(matchesWorkspaceFilters(candidate(head()), q({ platform: "instagram" }), TODAY)).toBe(true);
    expect(matchesWorkspaceFilters(candidate(head()), q({ platform: "youtube" }), TODAY)).toBe(false);
    expect(matchesWorkspaceFilters(candidate(vendorHead()), q({ platform: "instagram" }), TODAY)).toBe(false);
  });

  it("discrepancy=open needs at least one unresolved field", () => {
    expect(matchesWorkspaceFilters(candidate(head()), q({ discrepancy: "open" }), TODAY)).toBe(false);
    expect(matchesWorkspaceFilters(candidate(head({ display: display({ unresolvedFieldCount: 3 }) })), q({ discrepancy: "open" }), TODAY)).toBe(true);
    expect(matchesWorkspaceFilters(candidate(head({ display: null })), q({ discrepancy: "open" }), TODAY)).toBe(false);
  });

  it("filters combine with AND", () => {
    expect(matchesWorkspaceFilters(candidate(head()), q({ lifecycle: "ACTIVE", counterpartyType: "PARTNER", platform: "instagram", q: "acme" }), TODAY)).toBe(true);
    expect(matchesWorkspaceFilters(candidate(head()), q({ lifecycle: "ACTIVE", counterpartyType: "PARTNER", platform: "instagram", q: "nope" }), TODAY)).toBe(false);
  });
});

describe("matchesPeriodFilter", () => {
  const active = { status: "ACTIVE", activeVersion: 1, lastEndedVersion: null } as const;

  it("current = a governing (ACTIVE / SUSPENDED) version whose range covers today", () => {
    expect(matchesPeriodFilter(active, { effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }, "current", TODAY)).toBe(true);
    expect(matchesPeriodFilter(active, { effectiveFrom: "2026-01-01", effectiveTo: null }, "current", TODAY)).toBe(true);
    expect(matchesPeriodFilter(active, { effectiveFrom: "2026-03-10", effectiveTo: "2026-03-10" }, "current", TODAY)).toBe(true);
    expect(matchesPeriodFilter(active, { effectiveFrom: "2026-03-11", effectiveTo: null }, "current", TODAY)).toBe(false);
    expect(matchesPeriodFilter(active, { effectiveFrom: "2025-01-01", effectiveTo: "2026-03-09" }, "current", TODAY)).toBe(false);
    expect(matchesPeriodFilter({ status: "SUSPENDED", activeVersion: 1, lastEndedVersion: null }, { effectiveFrom: "2026-01-01", effectiveTo: null }, "current", TODAY)).toBe(true);
  });

  it("current excludes a never-activated draft, an ended agreement and a head with no projection", () => {
    expect(matchesPeriodFilter({ status: "DRAFT", activeVersion: null, lastEndedVersion: null }, { effectiveFrom: "2026-01-01", effectiveTo: null }, "current", TODAY)).toBe(false);
    expect(matchesPeriodFilter({ status: "ENDED", activeVersion: null, lastEndedVersion: 1 }, { effectiveFrom: "2026-01-01", effectiveTo: null }, "current", TODAY)).toBe(false);
    expect(matchesPeriodFilter(active, null, "current", TODAY)).toBe(false);
    expect(matchesPeriodFilter(active, { effectiveFrom: null, effectiveTo: null }, "current", TODAY)).toBe(false);
  });

  it("YYYY-MM = the effective range overlaps that calendar month (any lifecycle with dates), including leap-February edges", () => {
    const range = { effectiveFrom: "2026-02-15", effectiveTo: "2026-03-05" };
    expect(matchesPeriodFilter(active, range, "2026-02", TODAY)).toBe(true);
    expect(matchesPeriodFilter(active, range, "2026-03", TODAY)).toBe(true);
    expect(matchesPeriodFilter(active, range, "2026-01", TODAY)).toBe(false);
    expect(matchesPeriodFilter(active, range, "2026-04", TODAY)).toBe(false);
    expect(matchesPeriodFilter(active, { effectiveFrom: "2024-02-29", effectiveTo: "2024-02-29" }, "2024-02", TODAY)).toBe(true);
    expect(matchesPeriodFilter(active, { effectiveFrom: "2024-03-01", effectiveTo: null }, "2024-02", TODAY)).toBe(false);
    expect(matchesPeriodFilter({ status: "DRAFT", activeVersion: null, lastEndedVersion: null }, { effectiveFrom: "2026-03-01", effectiveTo: null }, "2026-06", TODAY)).toBe(true);
    expect(matchesPeriodFilter(active, range, "garbage", TODAY)).toBe(false);
  });
});

describe("deterministic order", () => {
  const h = (ref: string, updatedAt: string) => head({ agreementRef: ref, updatedAt });
  it("last updated newest first, then agreementRef ascending - a total order independent of input order", () => {
    const a = h("agr_00000000000000000001", "2026-03-02T00:00:00.000Z");
    const b = h("agr_00000000000000000002", "2026-03-03T00:00:00.000Z");
    const c = h("agr_00000000000000000003", "2026-03-03T00:00:00.000Z");
    const d = h("agr_00000000000000000004", "2026-03-01T00:00:00.000Z");
    const expected = [b, c, a, d].map((x) => x.agreementRef);
    for (const input of [[a, b, c, d], [d, c, b, a], [c, a, d, b], [b, d, a, c]]) expect([...input].sort(compareWorkspaceHeads).map((x) => x.agreementRef)).toEqual(expected);
    expect(compareWorkspaceHeads(a, a)).toBe(0);
  });
});

describe("currentVersionOf / primaryActionHint", () => {
  const perms = { canManage: true, canActivate: true };

  it("currentVersion is the governing version, else the open draft, else the latest", () => {
    expect(currentVersionOf(head({ status: "ACTIVE", activeVersion: 2, openVersion: 3, latestVersion: 3 }))).toBe(2);
    expect(currentVersionOf(head({ status: "DRAFT", activeVersion: null, openVersion: 1, latestVersion: 1 }))).toBe(1);
    expect(currentVersionOf(head({ status: "ENDED", activeVersion: null, openVersion: null, lastEndedVersion: 4, latestVersion: 4 }))).toBe(4);
  });

  it("an unconfirmed open version -> CONTINUE_DRAFT for a manager; read-only OPEN without manage", () => {
    const draft = head({ status: "DRAFT", activeVersion: null, openVersion: 1, display: display({ governingStatus: "DRAFT", openVersionConfirmed: false }) });
    expect(primaryActionHint(draft, perms)).toEqual({ kind: "CONTINUE_DRAFT", version: 1 });
    expect(primaryActionHint(draft, { canManage: false, canActivate: true })).toEqual({ kind: "OPEN", version: 1 });
    // a revision in progress is also a continue-draft
    expect(primaryActionHint(head({ status: "ACTIVE", activeVersion: 1, openVersion: 2, latestVersion: 2 }), perms)).toEqual({ kind: "CONTINUE_DRAFT", version: 2 });
  });

  it("a confirmed open version awaiting activation -> REVIEW only for someone who may activate", () => {
    const confirmed = head({ status: "DRAFT", activeVersion: null, openVersion: 1, display: display({ governingStatus: "DRAFT", openVersionConfirmed: true }) });
    expect(primaryActionHint(confirmed, perms)).toEqual({ kind: "REVIEW", version: 1 });
    expect(primaryActionHint(confirmed, { canManage: true, canActivate: false })).toEqual({ kind: "OPEN", version: 1 });
  });

  it("ACTIVE with nothing open -> CREATE_REVISION for someone who may activate; otherwise (and for SUSPENDED / ENDED) OPEN", () => {
    expect(primaryActionHint(head(), perms)).toEqual({ kind: "CREATE_REVISION", version: null });
    expect(primaryActionHint(head(), { canManage: true, canActivate: false })).toEqual({ kind: "OPEN", version: 1 });
    expect(primaryActionHint(head({ status: "SUSPENDED" }), perms)).toEqual({ kind: "OPEN", version: 1 });
    expect(primaryActionHint(head({ status: "ENDED", activeVersion: null, lastEndedVersion: 1 }), perms)).toEqual({ kind: "OPEN", version: 1 });
  });

  it("a head without a projection (legacy) still gets a safe hint", () => {
    expect(primaryActionHint(head({ status: "DRAFT", activeVersion: null, openVersion: 1, display: null }), perms)).toEqual({ kind: "CONTINUE_DRAFT", version: 1 });
  });
});
