import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { MODULE_ACTIONS } from "@/server/authz/module-actions";
import { PARTNER_REVIEW_LIFECYCLE_TRANSITIONS, canTransitionLifecycle } from "@/server/authz/lifecycle";
import type { ScopeGrant } from "@/server/authz/types";

import {
  toPartnerReviewHeadDto,
  toPartnerReviewVersionDto,
  toPartnerReviewVersionSummaryDto,
  type PartnerReviewDetailDto,
  type PartnerReviewFreshnessDto,
} from "./client-dto";
import { buildEvidence } from "./evidence-builder";
import { planPartnerReviewListQuery } from "./firestore";
import { derivePeriod, reviewRefFor } from "./period";
import {
  evidenceSnapshotSchema,
  partnerReviewHeadDocSchema,
  partnerReviewVersionDocSchema,
  PARTNER_REVIEW_STATUSES,
  type PartnerReviewHeadDoc,
  type PartnerReviewVersionDoc,
} from "./types";

// ---- Lifecycle graph -------------------------------------------------------------------

describe("PARTNER_REVIEW_LIFECYCLE_TRANSITIONS", () => {
  it("allows exactly DRAFT -> IN_REVIEW -> FINALIZED -> SUPERSEDED", () => {
    expect(canTransitionLifecycle("DRAFT", "IN_REVIEW", PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("IN_REVIEW", "FINALIZED", PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("FINALIZED", "SUPERSEDED", PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(true);
  });

  it("has no shortcut, no reverse edge and no self-loop", () => {
    const allowed = new Set(["DRAFT>IN_REVIEW", "IN_REVIEW>FINALIZED", "FINALIZED>SUPERSEDED"]);
    for (const from of PARTNER_REVIEW_STATUSES) {
      for (const to of PARTNER_REVIEW_STATUSES) {
        expect(canTransitionLifecycle(from, to, PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it("NEEDS_REVIEW is never a persisted state", () => {
    expect(Object.keys(PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)).not.toContain("NEEDS_REVIEW");
    expect(PARTNER_REVIEW_STATUSES as readonly string[]).not.toContain("NEEDS_REVIEW");
  });

  it("SUPERSEDED is only ever reachable from FINALIZED (never from a draft or in-review version)", () => {
    expect(PARTNER_REVIEW_LIFECYCLE_TRANSITIONS.SUPERSEDED).toEqual(["FINALIZED"]);
  });
});

// ---- Authorization catalog ---------------------------------------------------------------

describe("partner_reviews action catalog", () => {
  it("has the explicit create / submit / finalize / export actions and nothing rank-shaped", () => {
    expect(MODULE_ACTIONS.partner_reviews.map((a) => a.id)).toEqual(["create", "submit_partner_review", "finalize_approve", "export"]);
    expect(JSON.stringify(MODULE_ACTIONS.partner_reviews)).not.toMatch(/minimumRole|rank|wildcard|\*/i);
  });
});

// ---- Fixtures -----------------------------------------------------------------------------

const period = derivePeriod("2026-03")!;

function fixtureBuilt() {
  return buildEvidence({
    partnerRef: "partner-1",
    period,
    evidenceCutoff: "2026-05-01T00:00:00.000Z",
    assignments: [
      {
        assignmentRef: "as-1",
        campaignRef: "camp-1",
        status: "COMPLETED",
        version: 3,
        createdAt: "2026-01-10T08:00:00.000Z",
        updatedAt: "2026-02-01T08:00:00.000Z",
        brief: { campaignName: "Spring Launch", dueAt: "2026-03-10", requiredCount: 1, formats: ["reel"], platforms: ["instagram"] },
      },
    ],
    assignmentScanTruncated: false,
    assignmentsScanned: 1,
    threads: [
      {
        contentRef: "ct-1",
        assignmentRef: "as-1",
        version: 4,
        status: "APPROVED",
        currentRevisionNumber: 2,
        currentLinks: [{ platform: "instagram", originalUrl: "https://instagram.com/p/A", normalizedUrl: "https://instagram.com/p/a", recordedAt: "2026-03-08T10:00:00.000Z" }],
        openedAt: "2026-03-01T00:00:00.000Z",
        firstSubmittedAt: "2026-03-05T10:00:00.000Z",
        lastSubmittedAt: "2026-03-08T10:00:00.000Z",
        approvedAt: "2026-03-09T10:00:00.000Z",
        cancelledAt: null,
        updatedAt: "2026-03-09T10:00:00.000Z",
      },
    ],
    analyticsRecords: [
      {
        sourceRef: "src-1",
        batchRef: "batch-1",
        sheetName: "Posts",
        sourceRowNumber: 2,
        platform: "instagram",
        normalizedUrl: "https://instagram.com/p/a",
        postDateTimeIso: "2026-03-09T10:00:00.000Z",
        comments: null,
        likes: 120,
        views: null,
        profileFollowers: null,
        engagement: null,
        reportingPeriod: { start: "2026-03-01", end: "2026-03-31" },
        matchState: "MATCHED",
        matchEvidence: { tier: "published_url", value: "https://instagram.com/p/a", reasonCode: null, candidateCount: 1 },
        matchedContentRef: "ct-1",
        matchedAssignmentRef: "as-1",
        matchedCampaignRef: "camp-1",
        matchedPartnerRef: "partner-1",
        matchedPartnerAccountRef: null,
        correctionRevision: 1,
        createdAt: "2026-04-02T00:00:00.000Z",
      },
    ],
    analyticsScanTruncated: false,
    analyticsRecordsScanned: 1,
  });
}

function fixtureDocs(): { head: PartnerReviewHeadDoc; version: PartnerReviewVersionDoc } {
  const built = fixtureBuilt();
  const head = partnerReviewHeadDocSchema.parse({
    reviewRef: reviewRefFor("partner-1", "2026-03"),
    partnerRef: "partner-1",
    partnerUid: "partner-uid-1",
    periodKey: "2026-03",
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    latestVersion: 1,
    latestStatus: "DRAFT",
    currentFinalizedVersion: null,
    openVersion: 1,
    docVersion: 1,
    ownerUid: "owner-uid-1",
    regionIds: ["Kerala"],
    teamIds: ["team-1"],
    createdAt: "2026-05-01T00:00:00.000Z",
    createdByUserRef: "user-ref-1",
    updatedAt: "2026-05-01T00:00:00.000Z",
    updatedByUserRef: "user-ref-1",
  });
  const version = partnerReviewVersionDocSchema.parse({
    reviewRef: head.reviewRef,
    version: 1,
    status: "DRAFT",
    docVersion: 1,
    snapshot: built.snapshot,
    evidenceCutoff: built.snapshot.evidenceCutoff,
    sourceFingerprint: built.sourceFingerprint,
    sourceRefs: built.sourceRefs,
    generatedAt: "2026-05-01T00:00:00.000Z",
    generatedByUserRef: "user-ref-1",
    createdAt: "2026-05-01T00:00:00.000Z",
    createdByUserRef: "user-ref-1",
  });
  return { head, version };
}

// ---- No blended / composite / overall score anywhere ------------------------------------------

const FORBIDDEN_KEY = /(score|rating|overall|blended|composite|weighted|rank)/i;

// Every property name declared by a zod schema, recursing through
// objects, arrays, unions and wrappers. (Record keys are dynamic - they
// are covered by walking a real generated snapshot below.)
function schemaKeys(schema: unknown): string[] {
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (!def) return [];
  switch (def.type) {
    case "object":
      return Object.entries(def.shape as Record<string, unknown>).flatMap(([key, value]) => [key, ...schemaKeys(value)]);
    case "array":
      return schemaKeys(def.element);
    case "record":
      return schemaKeys(def.valueType);
    case "union":
      return (def.options as unknown[]).flatMap(schemaKeys);
    case "nullable":
    case "optional":
    case "default":
    case "readonly":
    case "prefault":
      return schemaKeys(def.innerType);
    default:
      return [];
  }
}

function dataKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(dataKeys);
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [key, ...dataKeys(child)]);
  return [];
}

// String values, EXCLUDING the documented performance.unavailableMetrics list
// (which legitimately lists registry ids such as blendedPerformanceScore as
// "not available").
function dataStringValues(value: unknown, skip: unknown): string[] {
  if (value === skip) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((child) => dataStringValues(child, skip));
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap((child) => dataStringValues(child, skip));
  return [];
}

describe("no blended/composite/overall score, rating, weight or rank exists anywhere", () => {
  it("the schema walker actually sees the schema (sanity - a broken walker cannot pass silently)", () => {
    const keys = schemaKeys(evidenceSnapshotSchema);
    expect(keys).toEqual(expect.arrayContaining(["production", "compliance", "performance", "completeness", "assignmentRef", "sourceRecordRef", "provenance", "metrics", "unavailableMetrics"]));
    expect(keys.length).toBeGreaterThan(60);
  });

  it("no key in the evidence snapshot / head / version schemas matches a score-like name", () => {
    for (const schema of [evidenceSnapshotSchema, partnerReviewHeadDocSchema, partnerReviewVersionDocSchema] as z.ZodType[]) {
      expect(schemaKeys(schema).filter((key) => FORBIDDEN_KEY.test(key))).toEqual([]);
    }
  });

  it("no key of a generated snapshot (incl. dynamic metric keys) matches a score-like name", () => {
    const { snapshot } = fixtureBuilt();
    expect(dataKeys(snapshot).filter((key) => FORBIDDEN_KEY.test(key))).toEqual([]);
  });

  it("no string value of a generated snapshot matches a score-like name, except the documented unavailableMetrics list", () => {
    const { snapshot } = fixtureBuilt();
    expect(dataStringValues(snapshot, snapshot.performance.unavailableMetrics).filter((v) => FORBIDDEN_KEY.test(v))).toEqual([]);
    // The documented exception really is the only place such names appear.
    expect(snapshot.performance.unavailableMetrics.some((v) => FORBIDDEN_KEY.test(v))).toBe(true);
    expect(snapshot.performance.unavailableMetrics).toContain("blendedPerformanceScore");
  });

  it("no key of any DTO shape matches a score-like name", () => {
    const { head, version } = fixtureDocs();
    const freshness: PartnerReviewFreshnessDto = { state: "current", incompleteReasons: [], version: 1, snapshotFingerprint: version.sourceFingerprint, currentFingerprint: version.sourceFingerprint, evaluatedAt: "2026-05-01T00:00:00.000Z" };
    const detail: PartnerReviewDetailDto = {
      head: toPartnerReviewHeadDto(head, "Creator One"),
      versions: [toPartnerReviewVersionSummaryDto(version)],
      hasMoreVersions: false,
      selectedVersion: toPartnerReviewVersionDto(version),
      freshness,
    };
    expect(dataKeys(detail).filter((key) => FORBIDDEN_KEY.test(key))).toEqual([]);
  });

  it("Production, Compliance and Performance are three independent sections with no cross-section aggregate", () => {
    const { snapshot } = fixtureBuilt();
    expect(Object.keys(snapshot).sort()).toEqual(["completeness", "compliance", "evidenceCutoff", "partnerRef", "performance", "periodEnd", "periodKey", "periodStart", "production", "schemaVersion", "sourceRefs"]);
    expect(Object.keys(snapshot.production)).toEqual(["assignments"]);
    expect(Object.keys(snapshot.compliance)).toEqual(["assignments"]);
    expect(Object.keys(snapshot.performance).sort()).toEqual(["latestImportedAt", "metricPresence", "records", "unavailableMetrics"]);
  });
});

// ---- DTO safety ----------------------------------------------------------------------------

describe("DTO safety", () => {
  it("exposes userRefs only - never a raw uid, scope snapshot, or Partner sensitive field", () => {
    const { head, version } = fixtureDocs();
    const json = JSON.stringify({ head: toPartnerReviewHeadDto(head, "Creator One"), version: toPartnerReviewVersionDto(version) });
    for (const forbidden of ["partner-uid-1", "owner-uid-1", "regionIds", "teamIds", "ownerUid", "partnerUid", "email", "phone", "legalName", "restricted", "pan", "iban"]) {
      expect(json).not.toContain(forbidden);
    }
    expect(json).toContain("user-ref-1");
    expect(json).toContain("Creator One");
    expect(json).toContain(head.reviewRef);
  });

  it("the head DTO carries only the safe allowlisted fields", () => {
    const { head } = fixtureDocs();
    expect(Object.keys(toPartnerReviewHeadDto(head, null)).sort()).toEqual(
      [
        "reviewRef",
        "partnerRef",
        "partnerDisplayName",
        "periodKey",
        "periodStart",
        "periodEnd",
        "latestVersion",
        "latestStatus",
        "currentFinalizedVersion",
        "openVersion",
        "docVersion",
        "createdAt",
        "createdByUserRef",
        "updatedAt",
        "updatedByUserRef",
      ].sort(),
    );
  });

  it("the snapshot exposes no raw Analytics row payload (caption/username/raw* fields) and no contact data", () => {
    const { snapshot } = fixtureBuilt();
    const keys = dataKeys(snapshot);
    for (const key of keys) expect(key).not.toMatch(/^raw|caption|username|email|phone|mediaUrl/i);
  });
});

// ---- Finance boundary ---------------------------------------------------------------------------

describe("Finance boundary", () => {
  it("no non-test source file of the module (or its routes) names or imports anything Finance-shaped", () => {
    const moduleDir = import.meta.dirname;
    const routesDir = path.resolve(moduleDir, "../../app/api/partner-reviews");

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
      }
    };
    walk(moduleDir);
    walk(routesDir);

    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect({ file: path.basename(file), hit: /finance|agreement|payable|invoice|payment/i.exec(source)?.[0] ?? null }).toEqual({ file: path.basename(file), hit: null });
    }
  });

  it("does not import from any Finance module path", () => {
    const moduleDir = import.meta.dirname;
    for (const name of readdirSync(moduleDir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      const imports = [...readFileSync(path.join(moduleDir, name), "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      expect(imports.filter((p) => /finance/i.test(p))).toEqual([]);
    }
  });
});

// ---- List planner ----------------------------------------------------------------------------------

describe("planPartnerReviewListQuery", () => {
  const AUDIT = { uid: "g", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "seed" };
  const grants: ScopeGrant[] = [
    { type: "SELF", ...AUDIT },
    { type: "REGION", region: "Kerala", ...AUDIT },
    { type: "TEAM", teamId: "t1", ...AUDIT },
    { type: "PARTNER", partnerId: "p-uid-1", ...AUDIT },
    { type: "EXPLICIT_RECORD", resourceType: "partner", resourceId: "p-uid-2", ...AUDIT },
    { type: "EXPLICIT_RECORD", resourceType: "content", resourceId: "ignored", ...AUDIT },
  ];

  it("decomposes scope into independent branches, ordered newest period first", () => {
    const { plan, orderField, orderDirection } = planPartnerReviewListQuery({ actorUid: "me", grants, hasGlobal: false });
    expect(plan.branches.map((b) => b.name)).toEqual(["self", "region", "team", "partnerGrant"]);
    expect([orderField, orderDirection]).toEqual(["periodKey", "desc"]);
  });

  it("the partner-grant branch honors both PARTNER and EXPLICIT partner grants (and nothing else)", () => {
    const { plan } = planPartnerReviewListQuery({ actorUid: "me", grants, hasGlobal: false });
    const branch = plan.branches.find((b) => b.name === "partnerGrant");
    expect(branch?.kind === "firestore-query" && branch.pushedFilters).toContainEqual({ field: "partnerUid", op: "in", value: ["p-uid-1", "p-uid-2"] });
  });

  it("lower-priority branches exclude what higher-priority ones already surface", () => {
    const { plan } = planPartnerReviewListQuery({ actorUid: "me", grants, hasGlobal: false });
    const byName = Object.fromEntries(plan.branches.map((b) => [b.name, b]));
    expect(byName.self!.excludePostFilters).toEqual([]);
    expect(byName.region!.excludePostFilters).toHaveLength(1);
    expect(byName.team!.excludePostFilters).toHaveLength(2);
    expect(byName.partnerGrant!.excludePostFilters).toHaveLength(3);
  });

  it("a GLOBAL actor gets one unscoped branch; an actor with no grants gets none", () => {
    expect(planPartnerReviewListQuery({ actorUid: "me", grants: [], hasGlobal: true }).plan.branches.map((b) => b.name)).toEqual(["main"]);
    expect(planPartnerReviewListQuery({ actorUid: "me", grants: [], hasGlobal: false }).plan.branches).toEqual([]);
  });

  it("a periodKey filter is pushed as a range on the order field itself; status stays an in-memory post-filter", () => {
    const { plan } = planPartnerReviewListQuery({ actorUid: "me", grants: [], hasGlobal: true, periodKey: "2026-03", status: "FINALIZED" });
    const branch = plan.branches[0]!;
    expect(branch.kind === "firestore-query" && branch.pushedFilters).toEqual([
      { field: "periodKey", op: ">=", value: "2026-03" },
      { field: "periodKey", op: "<=", value: "2026-03" },
    ]);
    expect(branch.postFilters).toEqual([{ field: "latestStatus", op: "==", value: "FINALIZED" }]);
  });

  it("an authorized single-Partner listing bypasses the head scope snapshot entirely", () => {
    const { plan } = planPartnerReviewListQuery({ actorUid: "me", grants: [], hasGlobal: false, partnerRef: "partner-1", partnerAuthorized: true });
    expect(plan.branches.map((b) => b.name)).toEqual(["partner"]);
  });
});
