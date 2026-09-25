import { z } from "zod";

import type { FeatureId } from "@/server/authz/features";

// Step 19A: the Governed Reports backend/domain foundation.
//
// Canonical principle (spec section "Mission"): Reports compose authoritative domain services; they
// do not create a second source of truth. Nothing in this module ever writes to a canonical
// Partner/Campaign/Assignment/Content/Analytics/Review/Finance/Operations collection, and (per
// section 3) Reports owns only: the catalog/definitions, orchestration, actor-safe projections,
// filter validation, metric labels, generated-at/evidence-cutoff metadata, limitations/disclosures,
// and (section 15) optional immutable finalized snapshots. Everything else is read straight through
// a source module's own already actor-scoped, already-safe public service function - see
// src/server/reports/families/*.ts.
//
// Shape family mirrors every other module's own {ok:true,data}|{ok:false,code,message} result
// contract (see src/server/operations/types.ts) - deliberately its own parallel type, never a shared
// import, same as every other module here keeps its own.

// --- Catalog ---------------------------------------------------------------------------------------
export const REPORT_IDS = [
  // Section 12: the six "high-value" families, fully certified in 19A.
  "campaign_delivery",
  "campaign_performance",
  "channel_growth_freshness",
  "partner_review_evidence",
  "finance_status",
  "operations_attention",
  // Section 4's remaining named families with a real, existing canonical source today - fully
  // executed in 19A (see the completion report for why these three, beyond the "at minimum" six in
  // section 12, were also given full execution rather than left catalog-only).
  "discovery_funnel",
  "partner_portfolio",
  "administration_security",
  // Section 13: the four "management-scale" families. Catalog-only, explicit "not yet implemented"
  // stubs in Step 19A (see families/management-scale-stubs.ts, since removed) - given real governed
  // execution in Step 19A.1 (see families/monthly-partner-performance.ts,
  // families/campaign-event-performance.ts, families/cross-platform-partner-programme.ts,
  // families/long-period-partner-programme.ts). The catalog now reaches 13/13 real execution.
  "monthly_partner_performance",
  "campaign_event_performance",
  "cross_platform_partner_programme",
  "long_period_partner_programme",
] as const;
export const reportIdSchema = z.enum(REPORT_IDS);
export type ReportId = z.infer<typeof reportIdSchema>;

export function isReportId(value: unknown): value is ReportId {
  return typeof value === "string" && (REPORT_IDS as readonly string[]).includes(value);
}

export type ReportExecutionSupport = "full" | "not_yet_implemented";

export const REPORT_FILTER_FIELD_TYPES = ["period", "periodRange", "partnerRef", "partnerAccountRef", "campaignRef", "platform", "status"] as const;
export type ReportFilterFieldType = (typeof REPORT_FILTER_FIELD_TYPES)[number];

export type ReportFilterFieldDef = { id: string; type: ReportFilterFieldType; label: string };

export const REPORT_ARTIFACT_FORMATS = ["pdf", "xlsx", "csv"] as const;
export type ReportArtifactFormat = (typeof REPORT_ARTIFACT_FORMATS)[number];

// A metric's own explicit source meaning (section 6: "every metric must have explicit source
// meaning"). `unavailableMeaning` documents what a null/absent value for this metric MEANS for this
// report - never silently coerced to 0.
export type ReportMetricDefinition = { id: string; label: string; meaning: string; unavailableMeaning?: string };

export type ReportSectionDefinition = { id: string; title: string };

// Section 4: the metadata a governed catalog entry carries. `requiredSourceFeatures` is the
// authorization surface (section 8/11): before Reports composes a family, the actor must already
// hold real FeatureAccess to every source module that family reads through - Reports never grants
// visibility into a module the actor could not already see directly, and never re-implements that
// module's own gate to decide it (see reports-gate.ts's requireReportsAccess).
export type ReportDefinition = {
  reportId: ReportId;
  version: number;
  title: string;
  purpose: string;
  sourceModules: string[];
  requiredSourceFeatures: FeatureId[];
  recordScopeNote: string;
  supportedFilters: ReportFilterFieldDef[];
  metrics: ReportMetricDefinition[];
  sections: ReportSectionDefinition[];
  limitations: string[];
  // Descriptive metadata only (section 16) - no file is ever generated in 19A.
  artifactFormats: ReportArtifactFormat[];
  executionSupport: ReportExecutionSupport;
  maxRows: number;
};

// --- Filters (section 7) ----------------------------------------------------------------------------
// Only keys the report's OWN definition declares in supportedFilters are ever honored; every other
// key present in the raw browser payload is silently dropped (never interpreted, never an implicit
// grant - section 7: "Requested IDs never grant access").
export type RawReportFilters = Record<string, unknown>;
export type AppliedReportFilters = Record<string, string>;

// --- Result contract (section 5) ---------------------------------------------------------------------
export type ReportScopeSummary = { basis: string; note: string };
export type ReportProvenanceEntry = { sourceModule: string; sourceFunction: string; recordCount: number; scanned?: number };
export type ReportRowValue = string | number | boolean | null;
export type ReportRow = Record<string, ReportRowValue>;

export type ReportResult = {
  reportId: ReportId;
  definitionVersion: number;
  // When CreatorOps ran this report - NEVER proof the underlying source data is fresh (section 5).
  generatedAt: string;
  // The freshness cutoff of the underlying EVIDENCE - for a live canonical-state report (Campaign
  // Delivery, Finance Status, Operations Attention, Partner Portfolio, Discovery Funnel,
  // Administration & Security, Partner Review Evidence - each read straight from current canonical
  // state) this equals generatedAt (there is no older "evidence" than the read itself). For an
  // Analytics-sourced report (Campaign Performance, Channel Growth & Freshness) it is the latest
  // matched source record's own import timestamp, which can be well before generatedAt - the whole
  // point of keeping the two fields distinct.
  evidenceCutoff: string;
  appliedFilters: AppliedReportFilters;
  scopeSummary: ReportScopeSummary;
  metrics: Record<string, number | string | null>;
  rows: ReportRow[];
  sections: Record<string, unknown>;
  limitations: string[];
  truncated: boolean;
  rowCount: number;
  maxRows: number;
  provenance: ReportProvenanceEntry[];
};

// --- Result/error plumbing - same shape family as every other module's own ------------------------
export type ReportsDenialReason = "not_authenticated" | "feature_denied" | "action_denied" | "scope_denied";

export type ReportsServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "unsupported" | "source_unavailable" | "size_exceeded" | "internal";

export type ReportsServiceResult<T> = { ok: true; data: T } | { ok: false; code: ReportsServiceErrorCode; message: string; reason?: ReportsDenialReason };

export type ReportsErrorResult = Extract<ReportsServiceResult<unknown>, { ok: false }>;

export function reportsUnauthorizedResult(reason: ReportsDenialReason): ReportsErrorResult {
  return { ok: false, code: "unauthorized", message: `Reports access denied (${reason}).`, reason };
}

export function reportsInvalidInputResult(message: string): ReportsErrorResult {
  return { ok: false, code: "invalid_input", message };
}

export const NEUTRAL_NOT_FOUND_MESSAGE = "Not found.";
export function reportsNotFoundResult(message: string = NEUTRAL_NOT_FOUND_MESSAGE): ReportsErrorResult {
  return { ok: false, code: "not_found", message };
}

export function reportsUnsupportedResult(message: string): ReportsErrorResult {
  return { ok: false, code: "unsupported", message };
}

export function reportsSourceUnavailableResult(message: string): ReportsErrorResult {
  return { ok: false, code: "source_unavailable", message };
}

export function reportsSizeExceededResult(message: string): ReportsErrorResult {
  return { ok: false, code: "size_exceeded", message };
}

export function reportsInternalResult(message = "Something went wrong."): ReportsErrorResult {
  return { ok: false, code: "internal", message };
}

// --- Finalized snapshot (section 15) -----------------------------------------------------------------
// The smallest immutable finalized-evidence model the spec requires. A snapshot pins the exact
// definition version, the full result (already a safe DTO - never a raw source document), and safe
// audit metadata. IMMUTABLE once written - see firestore.ts's own "no update/delete, only create".
const isoTimestamp = z.string().min(1);
const nonEmpty = z.string().min(1);

export const reportSnapshotDocSchema = z
  .object({
    snapshotRef: nonEmpty,
    reportId: reportIdSchema,
    definitionVersion: z.number().int().min(1),
    generatedAt: isoTimestamp,
    evidenceCutoff: isoTimestamp,
    appliedFilters: z.record(z.string(), z.string()),
    scopeSummary: z.object({ basis: nonEmpty, note: nonEmpty }),
    provenance: z.array(z.object({ sourceModule: nonEmpty, sourceFunction: nonEmpty, recordCount: z.number().int().min(0), scanned: z.number().int().min(0).optional() })),
    limitations: z.array(z.string()),
    truncated: z.boolean(),
    rowCount: z.number().int().min(0),
    maxRows: z.number().int().min(1),
    // The full safe result, exactly as returned to the actor who finalized it - never a raw source
    // document (every field already passed through the same source-module-safe DTOs the live run
    // uses).
    result: z.object({
      metrics: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
      rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
      sections: z.record(z.string(), z.unknown()),
    }),
    createdAt: isoTimestamp,
    createdByUserRef: nonEmpty,
  })
  .strict();
export type ReportSnapshotDoc = z.infer<typeof reportSnapshotDocSchema>;

export const finalizeReportInputSchema = z
  .object({
    reportId: reportIdSchema,
    filters: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type FinalizeReportInput = z.infer<typeof finalizeReportInputSchema>;

export const snapshotRefSchema = z.string().regex(/^rsn_[0-9a-f]{20}$/, "Invalid report snapshot reference.");

export const MAX_SNAPSHOT_LIST_PAGE_SIZE = 50;
export const DEFAULT_SNAPSHOT_LIST_PAGE_SIZE = 20;
