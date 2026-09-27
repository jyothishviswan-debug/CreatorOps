import type { ExcludedExportTarget, ExportTargetDefinition, ExportTargetId } from "./types";

// The governed export-target catalog. Every entry is explicit, hand-authored metadata - never
// derived from a source module's own schema at runtime (same discipline as
// src/server/reports/catalog.ts) - so a target's shape (filters, columns, limitations) is reviewable
// and stable independent of what the source module happens to return today.
//
// Deliberately a SMALL set (three targets) rather than a broad one: depth and correctness over
// breadth, per the spec's own explicit guidance. Each target composes exactly one existing,
// already actor-scoped "list" service - never a raw collection, never a second source of truth.
//
// Column allowlists are intentionally narrow. None of the three source DTOs (PartnerDto,
// CampaignDto, AssignmentDto) carry PAN/Aadhaar/bank/GSTIN/KYC/Drive-id/credential fields at all
// (those live behind separate, more-restricted services this module never calls), but each target
// still deliberately omits large/internal/nested fields that are not "columns" in any useful sense -
// see the per-target comment below for exactly what was left out and why.
const EXPORT_CATALOG: Record<ExportTargetId, ExportTargetDefinition> = {
  partners: {
    targetId: "partners",
    title: "Partners",
    description: "Partner roster rows - status, tier, region and ownership - sourced from the Partners service's own actor-scoped listPartners.",
    sourceModule: "partners",
    requiredSourceFeatures: ["partners"],
    recordScopeNote: "Rows are exactly the actor-scoped Partner rows listPartners already returns for the applied filters - no Partner outside the actor's own region/team/scope grants is ever included.",
    supportedFilters: [
      { id: "status", type: "status", label: "Status" },
      { id: "region", type: "region", label: "Region" },
    ],
    // Excluded deliberately: legalName (identity-adjacent, kept out of this bulk-export surface even
    // though it carries no restricted-category flag of its own), sourceDiscovery (a nested object,
    // not a column, and carries Discovery-internal evidence), originLeadRefs (internal cross-module
    // ref, not user-facing), version/statusReason/previousStatus (internal bookkeeping, not what an
    // export consumer needs). email/phone are ordinary business contact fields already shown on the
    // Partner detail page to any actor who can see the record - not sensitive-category data.
    columns: [
      { id: "partnerRef", label: "Partner ref" },
      { id: "displayName", label: "Display name" },
      { id: "status", label: "Status" },
      { id: "tier", label: "Tier" },
      { id: "priority", label: "Priority" },
      { id: "regionIds", label: "Regions" },
      { id: "categoryIds", label: "Categories" },
      { id: "email", label: "Email" },
      { id: "phone", label: "Phone" },
      { id: "ownerDisplayName", label: "Owner" },
      { id: "pendingPartnerAccountSetup", label: "Pending account setup" },
      { id: "createdAt", label: "Created at" },
      { id: "updatedAt", label: "Updated at" },
    ],
    defaultColumnIds: ["partnerRef", "displayName", "status", "tier", "regionIds", "ownerDisplayName"],
    allowedFormats: ["csv", "xlsx", "pdf"],
    limitations: ["Bounded to the first page listPartners returns (see maxRows) - a scope with more Partners than that is reported truncated.", "Restricted financial identity (bank/PAN/GSTIN) is never exposed here - Partners' own restricted-identity service is a separate, more strictly gated surface this module never calls."],
    // Section 9: this MUST equal the underlying domain service's own enforced page-size cap
    // (MAX_PARTNER_PAGE_SIZE / MAX_CAMPAIGN_PAGE_SIZE / MAX_ASSIGNMENT_PAGE_SIZE / MAX_VENDOR_PAGE_SIZE
    // / MAX_CONTENT_PAGE_SIZE / MAX_TASK_PAGE_SIZE / MAX_PARTNER_REVIEW_PAGE_SIZE - each is 100 today).
    // A prior version of this catalog advertised 500 while every one of those domain services silently
    // clamped `Math.min(options.limit, 100)` regardless of what was requested - meaning "truncated"
    // was already firing (and rows were already capped) at 100, not 500, and the UI's "bounded to 500
    // rows" claim was simply false. Fixed here: the advertised bound now matches the real one exactly,
    // so a "size_exceeded" rejection at maxRows corresponds to an actual, enforced limit.
    maxRows: 100,
  },
  campaigns: {
    targetId: "campaigns",
    title: "Campaigns",
    description: "Campaign roster rows - status, platforms, schedule and ownership - sourced from the Campaigns service's own actor-scoped listCampaigns.",
    sourceModule: "campaigns",
    requiredSourceFeatures: ["campaigns"],
    recordScopeNote: "Rows are exactly the actor-scoped Campaign rows listCampaigns already returns for the applied filters - no Campaign outside the actor's own region/team/scope grants is ever included.",
    supportedFilters: [
      { id: "status", type: "status", label: "Status" },
      { id: "region", type: "region", label: "Region" },
      { id: "platform", type: "platform", label: "Platform" },
    ],
    // Excluded deliberately: criteria/resources (large nested objects, not columns), version/
    // statusReason (internal bookkeeping), teamIds (internal team-routing detail, not what an export
    // consumer needs for a roster export).
    columns: [
      { id: "campaignRef", label: "Campaign ref" },
      { id: "name", label: "Name" },
      { id: "objective", label: "Objective" },
      { id: "status", label: "Status" },
      { id: "platforms", label: "Platforms" },
      { id: "startDate", label: "Start date" },
      { id: "endDate", label: "End date" },
      { id: "regionIds", label: "Regions" },
      { id: "ownerDisplayName", label: "Owner" },
      { id: "defaultReviewPolicy", label: "Review policy" },
      { id: "createdAt", label: "Created at" },
      { id: "updatedAt", label: "Updated at" },
    ],
    defaultColumnIds: ["campaignRef", "name", "status", "platforms", "startDate", "endDate"],
    allowedFormats: ["csv", "xlsx", "pdf"],
    limitations: ["Bounded to the first page listCampaigns returns (see maxRows) - a scope with more Campaigns than that is reported truncated."],
    // Section 9: this MUST equal the underlying domain service's own enforced page-size cap
    // (MAX_PARTNER_PAGE_SIZE / MAX_CAMPAIGN_PAGE_SIZE / MAX_ASSIGNMENT_PAGE_SIZE / MAX_VENDOR_PAGE_SIZE
    // / MAX_CONTENT_PAGE_SIZE / MAX_TASK_PAGE_SIZE / MAX_PARTNER_REVIEW_PAGE_SIZE - each is 100 today).
    // A prior version of this catalog advertised 500 while every one of those domain services silently
    // clamped `Math.min(options.limit, 100)` regardless of what was requested - meaning "truncated"
    // was already firing (and rows were already capped) at 100, not 500, and the UI's "bounded to 500
    // rows" claim was simply false. Fixed here: the advertised bound now matches the real one exactly,
    // so a "size_exceeded" rejection at maxRows corresponds to an actual, enforced limit.
    maxRows: 100,
  },
  assignments: {
    targetId: "assignments",
    title: "Assignments",
    description: "Assignment roster rows - Campaign/Partner linkage, lifecycle status and ownership - sourced from the Assignments service's own actor-scoped listAssignments.",
    sourceModule: "assignments",
    requiredSourceFeatures: ["assignments"],
    recordScopeNote: "Rows are exactly the actor-scoped Assignment rows listAssignments already returns for the applied filters - no Assignment outside the actor's own region/team/scope grants is ever included.",
    supportedFilters: [
      { id: "status", type: "status", label: "Status" },
      { id: "campaignRef", type: "text", label: "Campaign ref" },
      { id: "platform", type: "platform", label: "Platform" },
    ],
    // Excluded deliberately: brief (a nested object carrying free-form due-date/instructions detail,
    // not a flat column), partnerAccountRefs (internal cross-module ref - the display-label
    // equivalent, partnerAccountLabels, is exposed instead), version/statusReason/teamIds (internal
    // bookkeeping).
    columns: [
      { id: "assignmentRef", label: "Assignment ref" },
      { id: "campaignRef", label: "Campaign ref" },
      { id: "campaignName", label: "Campaign name" },
      { id: "partnerRef", label: "Partner ref" },
      { id: "partnerDisplayName", label: "Partner" },
      { id: "partnerAccountLabels", label: "Partner accounts" },
      { id: "status", label: "Status" },
      { id: "regionIds", label: "Regions" },
      { id: "ownerDisplayName", label: "Owner" },
      { id: "createdAt", label: "Created at" },
      { id: "updatedAt", label: "Updated at" },
    ],
    defaultColumnIds: ["assignmentRef", "campaignName", "partnerDisplayName", "status", "createdAt"],
    allowedFormats: ["csv", "xlsx", "pdf"],
    limitations: ["Bounded to the first page listAssignments returns (see maxRows) - a scope with more Assignments than that is reported truncated.", "A match count above maxRows is rejected (size_exceeded), never silently truncated - narrow the filters and try again."],
    // Section 9: this MUST equal the underlying domain service's own enforced page-size cap
    // (MAX_PARTNER_PAGE_SIZE / MAX_CAMPAIGN_PAGE_SIZE / MAX_ASSIGNMENT_PAGE_SIZE / MAX_VENDOR_PAGE_SIZE
    // / MAX_CONTENT_PAGE_SIZE / MAX_TASK_PAGE_SIZE / MAX_PARTNER_REVIEW_PAGE_SIZE - each is 100 today).
    // A prior version of this catalog advertised 500 while every one of those domain services silently
    // clamped `Math.min(options.limit, 100)` regardless of what was requested - meaning "truncated"
    // was already firing (and rows were already capped) at 100, not 500, and the UI's "bounded to 500
    // rows" claim was simply false. Fixed here: the advertised bound now matches the real one exactly,
    // so a "size_exceeded" rejection at maxRows corresponds to an actual, enforced limit.
    maxRows: 100,
  },

  // --- Section 2 "Required expansion" -----------------------------------------------------------
  // Each of the four targets below is added the SAME way as the original three: exactly one existing,
  // already actor-scoped domain "list" service, a hand-authored narrower column allowlist, and no new
  // Firestore access of this module's own invention.
  vendors: {
    targetId: "vendors",
    title: "Vendors",
    description: "Vendor roster rows - type, status and region - sourced from the Vendors service's own actor-scoped listVendors.",
    sourceModule: "vendors",
    requiredSourceFeatures: ["vendors"],
    recordScopeNote: "Rows are exactly the actor-scoped Vendor rows listVendors already returns for the applied filters - no Vendor outside the actor's own region/team/scope grants is ever included.",
    supportedFilters: [
      { id: "status", type: "status", label: "Status" },
      { id: "region", type: "region", label: "Region" },
      { id: "vendorType", type: "text", label: "Vendor type" },
    ],
    // Excluded deliberately: legalName (same identity-adjacent exclusion Partners already applies -
    // enforced by exports-static.test.ts's own forbidden-vocabulary scan), businessReferences (a
    // nested array of free-form label/value pairs that can carry business-registration-style
    // identifiers - not a flat column and not vetted as bulk-export-safe), version/previousStatus/
    // statusReason (internal bookkeeping), createdByUserRef/updatedByUserRef (raw internal user refs -
    // ownerDisplayName is the safe, already-resolved equivalent).
    columns: [
      { id: "vendorRef", label: "Vendor ref" },
      { id: "displayName", label: "Display name" },
      { id: "vendorType", label: "Vendor type" },
      { id: "status", label: "Status" },
      { id: "email", label: "Email" },
      { id: "phone", label: "Phone" },
      { id: "regionIds", label: "Regions" },
      { id: "ownerDisplayName", label: "Owner" },
      { id: "teamIds", label: "Teams" },
      { id: "createdAt", label: "Created at" },
      { id: "updatedAt", label: "Updated at" },
    ],
    defaultColumnIds: ["vendorRef", "displayName", "vendorType", "status", "regionIds", "ownerDisplayName"],
    allowedFormats: ["csv", "xlsx", "pdf"],
    limitations: ["Bounded to the first page listVendors returns (see maxRows) - a match count above maxRows is rejected (size_exceeded), never silently truncated."],
    // Section 9: this MUST equal the underlying domain service's own enforced page-size cap
    // (MAX_PARTNER_PAGE_SIZE / MAX_CAMPAIGN_PAGE_SIZE / MAX_ASSIGNMENT_PAGE_SIZE / MAX_VENDOR_PAGE_SIZE
    // / MAX_CONTENT_PAGE_SIZE / MAX_TASK_PAGE_SIZE / MAX_PARTNER_REVIEW_PAGE_SIZE - each is 100 today).
    // A prior version of this catalog advertised 500 while every one of those domain services silently
    // clamped `Math.min(options.limit, 100)` regardless of what was requested - meaning "truncated"
    // was already firing (and rows were already capped) at 100, not 500, and the UI's "bounded to 500
    // rows" claim was simply false. Fixed here: the advertised bound now matches the real one exactly,
    // so a "size_exceeded" rejection at maxRows corresponds to an actual, enforced limit.
    maxRows: 100,
  },
  content: {
    targetId: "content",
    title: "Content",
    description: "Content submission-thread rows - lifecycle status, linkage to Campaign/Assignment/Partner and key dates - sourced from the Content service's own actor-scoped listContent.",
    sourceModule: "content",
    requiredSourceFeatures: ["content"],
    recordScopeNote: "Rows are exactly the actor-scoped Content rows listContent already returns for the applied filters - no Content outside the actor's own region/team/scope grants is ever included.",
    supportedFilters: [
      { id: "status", type: "status", label: "Status" },
      { id: "campaignRef", type: "text", label: "Campaign ref" },
      { id: "assignmentRef", type: "text", label: "Assignment ref" },
      { id: "partnerRef", type: "text", label: "Partner ref" },
    ],
    // Excluded deliberately: currentLinks (a nested array of per-platform link/metric rows, not a
    // flat column - the platform-level detail this carries belongs to Analytics, not a Content
    // roster export), qualifyingFulfillment (a nested object), version/statusReason (internal
    // bookkeeping), ownerRef/teamIds' raw internal equivalents where a display name already exists.
    columns: [
      { id: "contentRef", label: "Content ref" },
      { id: "campaignRef", label: "Campaign ref" },
      { id: "campaignName", label: "Campaign name" },
      { id: "assignmentRef", label: "Assignment ref" },
      { id: "partnerRef", label: "Partner ref" },
      { id: "partnerDisplayName", label: "Partner" },
      { id: "status", label: "Status" },
      { id: "currentRevisionNumber", label: "Current revision" },
      { id: "dueAt", label: "Due at" },
      { id: "openedAt", label: "Opened at" },
      { id: "firstSubmittedAt", label: "First submitted at" },
      { id: "lastSubmittedAt", label: "Last submitted at" },
      { id: "approvedAt", label: "Approved at" },
      { id: "regionIds", label: "Regions" },
      { id: "ownerDisplayName", label: "Owner" },
    ],
    defaultColumnIds: ["contentRef", "campaignName", "partnerDisplayName", "status", "dueAt", "approvedAt"],
    allowedFormats: ["csv", "xlsx", "pdf"],
    limitations: ["Bounded to the first page listContent returns (see maxRows) - a match count above maxRows is rejected (size_exceeded), never silently truncated."],
    // Section 9: this MUST equal the underlying domain service's own enforced page-size cap
    // (MAX_PARTNER_PAGE_SIZE / MAX_CAMPAIGN_PAGE_SIZE / MAX_ASSIGNMENT_PAGE_SIZE / MAX_VENDOR_PAGE_SIZE
    // / MAX_CONTENT_PAGE_SIZE / MAX_TASK_PAGE_SIZE / MAX_PARTNER_REVIEW_PAGE_SIZE - each is 100 today).
    // A prior version of this catalog advertised 500 while every one of those domain services silently
    // clamped `Math.min(options.limit, 100)` regardless of what was requested - meaning "truncated"
    // was already firing (and rows were already capped) at 100, not 500, and the UI's "bounded to 500
    // rows" claim was simply false. Fixed here: the advertised bound now matches the real one exactly,
    // so a "size_exceeded" rejection at maxRows corresponds to an actual, enforced limit.
    maxRows: 100,
  },
  operations_tasks: {
    targetId: "operations_tasks",
    title: "Operations Tasks",
    description: "Operations coordination-task rows - priority, status, assignee and target linkage - sourced from the Operations service's own actor-scoped listTasks.",
    sourceModule: "operations",
    requiredSourceFeatures: ["operations"],
    recordScopeNote: "Rows are exactly the actor-scoped Task rows listTasks already returns (an actor without global scope sees only their own assigned Tasks) - never an unscoped board-wide dump.",
    supportedFilters: [
      { id: "status", type: "status", label: "Status" },
      { id: "priority", type: "text", label: "Priority" },
      { id: "targetType", type: "text", label: "Target type" },
    ],
    // Excluded deliberately: assigneeUserRef/createdByUserRef (raw internal user refs -
    // assigneeDisplayName is the safe, already-resolved equivalent), target (a nested reference
    // object - targetDisplayName is the flat, safe equivalent), latestVersion/docVersion (internal
    // optimistic-concurrency bookkeeping, not a business column).
    columns: [
      { id: "taskRef", label: "Task ref" },
      { id: "title", label: "Title" },
      { id: "targetDisplayName", label: "Target" },
      { id: "assigneeDisplayName", label: "Assignee" },
      { id: "origin", label: "Origin" },
      { id: "priority", label: "Priority" },
      { id: "status", label: "Status" },
      { id: "dueAt", label: "Due at" },
      { id: "isOverdue", label: "Overdue" },
      { id: "blockedReason", label: "Blocked reason" },
      { id: "cancelledReason", label: "Cancelled reason" },
      { id: "createdAt", label: "Created at" },
      { id: "updatedAt", label: "Updated at" },
    ],
    defaultColumnIds: ["taskRef", "title", "assigneeDisplayName", "status", "priority", "dueAt"],
    allowedFormats: ["csv", "xlsx", "pdf"],
    limitations: [
      "Bounded to the first page listTasks returns (see maxRows) - a match count above maxRows is rejected (size_exceeded), never silently truncated.",
      "A non-global actor sees only their own assigned Tasks (listTasks' own scope rule), never a full board.",
      "listTasks has no pagination cursor (unlike every other target here), so this bound is deliberately one row below the domain's own page cap (100) - a full domain page back is conservatively treated as \"more rows exist\", which means an exact 100-row match is also rejected rather than risk an undetectable silent truncation.",
    ],
    // See sources/operations-tasks-source.ts's own comment: listTasks has no nextCursor, so this
    // fetcher always requests the domain's full page (100, MAX_TASK_PAGE_SIZE) and infers "more rows
    // exist" from getting a full page back. maxRows is therefore deliberately 99, not 100 - the one
    // value that keeps the inference exact everywhere except the single unavoidable boundary case
    // (exactly 100 matches, no more) called out above.
    maxRows: 99,
  },
  partner_reviews: {
    targetId: "partner_reviews",
    title: "Partner Reviews",
    description: "Partner Review summary rows - period, status and version bookkeeping only - sourced from the Partner Reviews service's own actor-scoped, evidence-free listPartnerReviewHeads.",
    sourceModule: "partner-reviews",
    requiredSourceFeatures: ["partner_reviews"],
    recordScopeNote: "Rows are exactly the actor-scoped Partner Review head rows listPartnerReviewHeads already returns for the applied filters - no Review outside the actor's own region/team/scope grants is ever included.",
    supportedFilters: [
      { id: "status", type: "status", label: "Status" },
      { id: "partnerRef", type: "text", label: "Partner ref" },
      { id: "periodKey", type: "text", label: "Period (YYYY-MM)" },
    ],
    // Excluded deliberately, and structurally impossible to widen by accident: this target's own
    // fetcher (sources/partner-reviews-source.ts) calls ONLY listPartnerReviewHeads, which is
    // documented at its own definition site as never importing the evidence collector, the freshness
    // evaluator, or any upstream Assignment/Content/Analytics reader - so no Production/Compliance/
    // Performance section evidence, extraction, or freshness detail can ever reach this target, even
    // in the future, without a deliberate new fetcher. docVersion (internal optimistic-concurrency
    // bookkeeping) and createdByUserRef/updatedByUserRef (raw internal user refs) are also excluded.
    columns: [
      { id: "reviewRef", label: "Review ref" },
      { id: "partnerRef", label: "Partner ref" },
      { id: "partnerDisplayName", label: "Partner" },
      { id: "periodKey", label: "Period" },
      { id: "periodStart", label: "Period start" },
      { id: "periodEnd", label: "Period end" },
      { id: "latestStatus", label: "Latest status" },
      { id: "currentFinalizedVersion", label: "Finalized version" },
      { id: "openVersion", label: "Open version" },
      { id: "createdAt", label: "Created at" },
      { id: "updatedAt", label: "Updated at" },
    ],
    defaultColumnIds: ["reviewRef", "partnerDisplayName", "periodKey", "latestStatus", "currentFinalizedVersion"],
    allowedFormats: ["csv", "xlsx", "pdf"],
    limitations: ["Bounded to the first page listPartnerReviewHeads returns (see maxRows) - a match count above maxRows is rejected (size_exceeded), never silently truncated.", "Summary/bookkeeping only - no Production/Compliance/Performance evidence or extraction detail is ever included (see Partner Reviews' own list-service boundary)."],
    // Section 9: this MUST equal the underlying domain service's own enforced page-size cap
    // (MAX_PARTNER_PAGE_SIZE / MAX_CAMPAIGN_PAGE_SIZE / MAX_ASSIGNMENT_PAGE_SIZE / MAX_VENDOR_PAGE_SIZE
    // / MAX_CONTENT_PAGE_SIZE / MAX_TASK_PAGE_SIZE / MAX_PARTNER_REVIEW_PAGE_SIZE - each is 100 today).
    // A prior version of this catalog advertised 500 while every one of those domain services silently
    // clamped `Math.min(options.limit, 100)` regardless of what was requested - meaning "truncated"
    // was already firing (and rows were already capped) at 100, not 500, and the UI's "bounded to 500
    // rows" claim was simply false. Fixed here: the advertised bound now matches the real one exactly,
    // so a "size_exceeded" rejection at maxRows corresponds to an actual, enforced limit.
    maxRows: 100,
  },
};

// --- Section 2 audit result: domains explicitly considered and NOT added to EXPORT_TARGET_IDS -------
// This is documented, enforced metadata (never derived from EXPORT_TARGET_IDS, and never served to the
// browser - see exports-static.test.ts's "do not leak hidden target existence" guard) so a reviewer
// can see exactly what was excluded and why, rather than a target's absence being unexplained.
const EXCLUDED_EXPORT_TARGETS: ExcludedExportTarget[] = [
  {
    id: "partner_accounts",
    title: "Partner Accounts",
    classification: "INTENTIONALLY_UNSUPPORTED",
    reason:
      "No actor-scoped, bounded, cross-Partner list service exists today - Partners' own listPartnerAccounts(actor, partnerRef) is deliberately per-Partner only (mirrors the Partner detail page's own access shape). Building a bulk export would require either a new cross-Partner read model (a real new service, out of this stage's 'compose an existing service' discipline) or an N-Partner fan-out (forbidden - see sources/*.ts's own single-bounded-call discipline). Revisit once/if a genuine bulk Partner Accounts read model exists.",
  },
  {
    id: "analytics_evidence",
    title: "Analytics safe evidence/export view",
    classification: "FUTURE",
    reason:
      "listAnalyticsSourceRecords is real, bounded and actor-scoped, but it returns two distinct raw Firestore doc shapes (AnalyticsContentSourceRecordDoc / AnalyticsChannelSourceRecordDoc) with a recordKind discriminator, matchEvidence detail, and raw*/normalized* field pairs that were never designed as a flat export-safe row. A defensible export needs a dedicated safe projection (excluding raw-evidence internals) designed and reviewed on its own, not assembled under this stage's time budget. Flagged as an explicit follow-on, not silently dropped.",
  },
  {
    id: "finance_safe",
    title: "Finance-safe business outputs",
    classification: "FUTURE",
    reason:
      "Finance-Invoices/Payments/Payables each expose a bounded, actor-scoped *Workspace service, but a genuinely safe export needs (a) a field-level design pass to guarantee zero KYC/bank/tax-identity leakage from those workspace DTOs, and (b) confirmation of which existing permission is the correct READ-scoped 'can view Finance records' grant (this module must never reuse manage_agreements - a write permission - as a stand-in). Neither was completed within this stage's time budget; implementing it hastily is a worse outcome than deferring it explicitly.",
  },
  {
    id: "administration_security",
    title: "Administration / Security",
    classification: "RESTRICTED",
    reason: "Per the spec's own explicit guidance: Administration/Security stays restricted or unsupported for ordinary export unless there is a tightly-governed, explicitly-authorized use case. No such case was presented in this stage.",
  },
  {
    id: "reports_analytical_publications",
    title: "Reports (narrative/versioned analytical publications)",
    classification: "REPORT_ONLY",
    reason: "An analytical publication with narrative/versioning/finalization semantics is, by the spec's own Export-vs-Reports boundary (section 19), a Reports concern, not an Export Center target - Export Center never gains report taxonomy or finalization semantics.",
  },
];

export function getExcludedExportTargets(): ExcludedExportTarget[] {
  return EXCLUDED_EXPORT_TARGETS;
}

export function getExportTargetDefinition(targetId: ExportTargetId): ExportTargetDefinition {
  return EXPORT_CATALOG[targetId];
}

export function listExportTargetDefinitions(): ExportTargetDefinition[] {
  return Object.values(EXPORT_CATALOG);
}
