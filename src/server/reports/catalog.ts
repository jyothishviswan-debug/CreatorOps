import type { ReportDefinition, ReportId } from "./types";

// Step 19A section 4: the governed catalog. Every entry is explicit, hand-authored metadata - never
// derived from a source module's own schema at runtime - so a definition's shape (filters, metrics,
// sections, limitations) is reviewable and stable independent of what any source module happens to
// return today. reportIds are preserved/matched against the illustrative names the UI-placeholder
// fixtures already imply (src/features/reports/fixtures/index.ts's "Monthly Partner",
// "Campaign / Event", "Cross-platform", "Long-period" catalog rows) wherever a stable slug made
// sense; the six section-12 "high-value" ids and the three additional fully-executed ids (Discovery
// Funnel, Partner Portfolio, Administration & Security) have no illustrative fixture precedent, so
// they use the product-authority's own plain family name.

const REPORT_CATALOG: Record<ReportId, ReportDefinition> = {
  // ---------------------------------------------------------------------------------------------
  // Section 12 "high-value" families - full execution.
  // ---------------------------------------------------------------------------------------------
  campaign_delivery: {
    reportId: "campaign_delivery",
    version: 1,
    title: "Campaign Delivery",
    purpose: "Fulfillment, timeliness and review/publication evidence for a Campaign's Assignments and Content, sourced from the Campaigns, Assignments and Content services.",
    sourceModules: ["campaigns", "assignments", "content"],
    requiredSourceFeatures: ["campaigns", "assignments", "content"],
    recordScopeNote: "Rows are exactly the Campaigns/Assignments/Content the acting user's own scope grants already permit listAssignments/listContent to return - no record outside that scope is ever included, counted, or referenced.",
    supportedFilters: [
      { id: "campaignRef", type: "campaignRef", label: "Campaign" },
      { id: "platform", type: "platform", label: "Platform" },
      { id: "status", type: "status", label: "Assignment status" },
    ],
    metrics: [
      { id: "assignmentCount", label: "Assignments in scope", meaning: "Count of actor-scoped Assignment rows returned by listAssignments for the applied filters." },
      { id: "completedAssignmentCount", label: "Completed assignments", meaning: "Assignments whose status is COMPLETED." },
      { id: "overdueAssignmentCount", label: "Overdue (brief due date passed, not completed)", meaning: "Assignments whose brief.dueAt is before generatedAt and status is not COMPLETED/CANCELLED.", unavailableMeaning: "Never fabricated - an Assignment with no brief.dueAt is excluded from this count entirely, not treated as on-time." },
      { id: "contentApprovedCount", label: "Content approved", meaning: "Content rows whose status is APPROVED." },
      { id: "contentUnderReviewCount", label: "Content under review", meaning: "Content rows whose status is UNDER_REVIEW or REVISION_REQUESTED." },
    ],
    sections: [{ id: "assignments", title: "Assignments" }, { id: "content", title: "Content" }],
    limitations: ["Bounded to the first page of each source module's own list function (see maxRows) - a Campaign with more Assignments/Content than that is reported truncated, never silently incomplete without disclosure."],
    artifactFormats: ["pdf", "xlsx", "csv"],
    executionSupport: "full",
    maxRows: 200,
  },
  campaign_performance: {
    reportId: "campaign_performance",
    version: 1,
    title: "Campaign Performance",
    purpose: "Verified (MATCHED-evidence-only) Analytics outcomes for a Campaign's published Content, kept strictly per-platform.",
    sourceModules: ["analytics"],
    requiredSourceFeatures: ["analytics"],
    recordScopeNote: "Rows are exactly the actor-scoped Analytics content source records getPlatformAnalyticsView already returns for the applied platform - no cross-actor or cross-scope record is ever included.",
    supportedFilters: [
      { id: "campaignRef", type: "campaignRef", label: "Campaign" },
      { id: "platform", type: "platform", label: "Platform" },
    ],
    metrics: [
      { id: "matchedContentCount", label: "Matched content rows", meaning: "Content source records with matchState === MATCHED for the applied platform." },
      { id: "viewsByPlatform", label: "Views (per platform)", meaning: "Sum of the `views` metric across matched rows, kept separate per platform - never combined across platforms.", unavailableMeaning: "A platform with no matched rows reports null (unavailable), never 0." },
      { id: "engagementByPlatform", label: "Engagement (per platform)", meaning: "Sum of the `engagement` metric across matched rows, per platform.", unavailableMeaning: "Null when no matched row reports engagement for that platform - never 0." },
    ],
    sections: [{ id: "contentByPlatform", title: "Content by platform" }],
    limitations: [
      "Reach/impressions are not modeled by Analytics and are never substituted with views.",
      "Only MATCHED-evidence rows are counted; UNMATCHED/AMBIGUOUS source records are excluded from every metric (never guessed).",
      "Platform metrics are never combined into a single cross-platform total.",
    ],
    artifactFormats: ["pdf", "xlsx", "csv"],
    executionSupport: "full",
    maxRows: 200,
  },
  channel_growth_freshness: {
    reportId: "channel_growth_freshness",
    version: 1,
    title: "Channel Growth & Freshness",
    purpose: "Partner Account follower snapshots with explicit source-timestamp freshness, distinguishing unavailable from stale evidence honestly.",
    sourceModules: ["analytics", "partners"],
    requiredSourceFeatures: ["analytics", "partners"],
    recordScopeNote: "Rows are exactly the actor-scoped channel/account rows getPartnerAnalyticsView already returns for the applied Partner - no record outside the actor's own Partner/Analytics scope is ever included.",
    supportedFilters: [
      { id: "partnerRef", type: "partnerRef", label: "Partner" },
      { id: "platform", type: "platform", label: "Platform" },
    ],
    metrics: [
      { id: "accountCount", label: "Accounts reported", meaning: "Count of Partner Account channel rows returned for the applied Partner/platform." },
      { id: "staleAccountCount", label: "Stale snapshots (>60 days old)", meaning: "Accounts whose latest snapshotAt is more than 60 days before generatedAt - Reports' own explicit staleness threshold (Analytics models no staleness concept of its own)." },
      { id: "unavailableAccountCount", label: "No snapshot on file", meaning: "Accounts with no channel source record at all - distinct from a stale one; never conflated." },
    ],
    sections: [{ id: "accounts", title: "Partner accounts" }],
    limitations: ["snapshotAt is the source record's own import time, not a live platform read - freshness is always relative to when CreatorOps last imported the data, never real-time.", "The 60-day staleness threshold is a Reports-defined disclosure convention, not a value Analytics itself asserts."],
    artifactFormats: ["pdf", "xlsx", "csv"],
    executionSupport: "full",
    maxRows: 200,
  },
  partner_review_evidence: {
    reportId: "partner_review_evidence",
    version: 1,
    title: "Partner Review Evidence",
    purpose: "Finalized Partner Review evidence only, with Production, Compliance and Performance kept as fully separate sections - never blended into one score.",
    sourceModules: ["partner_reviews"],
    requiredSourceFeatures: ["partner_reviews"],
    recordScopeNote: "Rows are exactly the actor-scoped, FINALIZED Partner Review heads listPartnerReviewHeads already returns - no Draft/In Review/Superseded evidence is ever surfaced.",
    supportedFilters: [
      { id: "partnerRef", type: "partnerRef", label: "Partner" },
      { id: "period", type: "period", label: "Period (YYYY-MM)" },
    ],
    metrics: [
      { id: "finalizedReviewCount", label: "Finalized reviews", meaning: "Count of Partner Review heads with a non-null currentFinalizedVersion for the applied filters." },
      { id: "withComplianceEvidenceCount", label: "Reviews with Compliance evidence", meaning: "Finalized reviews whose Compliance section has at least one assignment entry." },
      { id: "withPerformanceEvidenceCount", label: "Reviews with Performance evidence", meaning: "Finalized reviews whose Performance section has at least one metric present." },
    ],
    sections: [{ id: "production", title: "Production" }, { id: "compliance", title: "Compliance" }, { id: "performance", title: "Performance" }],
    limitations: ["No blended/composite score is computed anywhere in this report - Production, Compliance and Performance are reported as three fully independent sections, matching Partner Reviews' own schema (which has no blended-score field either).", "Commercial evidence (deliverable/LFC-SFC/targets) is out of scope for this family in 19A."],
    artifactFormats: ["pdf", "xlsx", "csv"],
    executionSupport: "full",
    maxRows: 200,
  },
  finance_status: {
    reportId: "finance_status",
    version: 1,
    title: "Finance Status",
    purpose: "Agreement/Payable/Invoice/Payment lifecycle and role-safe amount status per Partner/Vendor, through each Finance module's own safe workspace service.",
    sourceModules: ["finance-agreements", "finance-payables", "finance-invoices", "finance-payments"],
    requiredSourceFeatures: ["finance"],
    recordScopeNote: "Rows are exactly the actor-scoped workspace rows listAgreementsWorkspace/listPayablesWorkspace/listInvoicesWorkspace/listPaymentsWorkspace already return - amount fields already resolve to null (never a fabricated value) whenever the actor lacks the finance_amounts sensitive category, per each module's own amountsVisible gate.",
    supportedFilters: [
      { id: "partnerRef", type: "partnerRef", label: "Partner/Vendor counterparty" },
      { id: "status", type: "status", label: "Lifecycle status" },
    ],
    metrics: [
      { id: "activeAgreementCount", label: "Active agreements", meaning: "Agreement workspace rows with lifecycle === ACTIVE." },
      { id: "payableTotalAmountMinorSigned", label: "Payable net total (signed, minor units)", meaning: "Sum of PayableRowDto.totalAmountMinorSigned across in-scope Payables - the net signed payable amount, kept distinct from GST/TDS/gross figures.", unavailableMeaning: "Null (never 0) when amountsVisible is false for the acting role." },
      { id: "invoiceDeclaredGrossMinor", label: "Invoice declared gross total (minor units)", meaning: "Sum of InvoiceRowDto.declaredTotalMinor - the gross Invoice amount as declared by the supplier, kept distinct from Payable/Payment figures.", unavailableMeaning: "Null when amounts are not visible to the acting role." },
      { id: "paymentSettledMinor", label: "Payment settled total (minor units)", meaning: "Sum of PaymentRowDto.amountMinor across CONFIRMED payments - the actual recorded settlement amount, kept distinct from the expected net payment figure.", unavailableMeaning: "Null when amounts are not visible to the acting role." },
    ],
    sections: [{ id: "agreements", title: "Agreements" }, { id: "payables", title: "Payables" }, { id: "invoices", title: "Invoices" }, { id: "payments", title: "Payments" }],
    limitations: [
      "Amount fields are exactly those already exposed on each module's own bounded WORKSPACE ROW dto (avoiding a per-record detail fetch/N+1 fan-out) - the finer service-base/GST/TDS/expected-net-payment breakdown lives on each record's own detail view and is not repeated here; open the record itself for that breakdown.",
      "Service base / GST / gross Invoice / TDS / expected net payment / settlement amounts are always reported as separate figures - never summed together into one blended number.",
      "No PAN, Aadhaar, full bank account, restricted GSTIN, raw KYC or restricted extraction data ever appears in this report - each Finance module's own workspace DTO already omits them before Reports ever sees a row.",
    ],
    artifactFormats: ["pdf", "xlsx", "csv"],
    executionSupport: "full",
    maxRows: 200,
  },
  operations_attention: {
    reportId: "operations_attention",
    version: 1,
    title: "Operations Attention",
    purpose: "Open Tasks, live pending Approval Queue items and scheduled/due Reminders needing attention - a live read composed fresh, never a second persisted approval/task truth.",
    sourceModules: ["operations"],
    requiredSourceFeatures: ["operations"],
    recordScopeNote: "Rows are exactly the actor-scoped Task/Reminder heads listTasks/listReminders already return, plus the Approval Queue items listApprovalQueue already returns (itself re-derived, per-item, from each source module's own gate) - no record outside the actor's own Operations/source scope is ever included.",
    supportedFilters: [{ id: "status", type: "status", label: "Task/Reminder status" }],
    metrics: [
      { id: "openTaskCount", label: "Open/in-progress/blocked tasks", meaning: "Task rows whose status is OPEN, IN_PROGRESS or BLOCKED." },
      { id: "overdueTaskCount", label: "Overdue tasks", meaning: "Task rows whose own isOverdue field (derived by Operations, never recomputed here) is true." },
      { id: "pendingApprovalCount", label: "Pending Approval Queue items", meaning: "Count of live Approval Queue items across all four source modules, exactly as listApprovalQueue reports today." },
      { id: "dueReminderCount", label: "Due reminders", meaning: "Reminder rows whose effective status (deriveReminderEffectiveStatus) is DUE." },
    ],
    sections: [{ id: "tasks", title: "Tasks" }, { id: "approvalQueue", title: "Approval Queue" }, { id: "reminders", title: "Reminders" }],
    limitations: ["The Approval Queue section is READ-ONLY and always live - Reports persists nothing about it (no second approval status), matching Operations' own Step 18A design.", "generatedAt/evidenceCutoff are identical for this report - there is no older 'evidence' than the read itself for live operational state."],
    artifactFormats: ["pdf", "xlsx", "csv"],
    executionSupport: "full",
    maxRows: 300,
  },
  // ---------------------------------------------------------------------------------------------
  // Additional fully-executed families with a real existing canonical source (beyond the
  // section-12 minimum six).
  // ---------------------------------------------------------------------------------------------
  discovery_funnel: {
    reportId: "discovery_funnel",
    version: 1,
    title: "Discovery Funnel",
    purpose: "Lead lifecycle-stage counts (research through conversion, and watchlist/rejected/archived) from the Discovery service.",
    sourceModules: ["discovery"],
    requiredSourceFeatures: ["discovery"],
    recordScopeNote: "Rows are exactly the actor-scoped Lead rows listLeads already returns for the applied filters - no Lead outside the actor's own scope is ever included, counted, or referenced.",
    supportedFilters: [{ id: "platform", type: "platform", label: "Platform" }],
    metrics: [
      { id: "leadCount", label: "Leads in scope", meaning: "Count of actor-scoped Lead rows returned by listLeads for the applied filters." },
      { id: "convertedCount", label: "Converted", meaning: "Lead rows with lifecycle === CONVERTED." },
      { id: "watchlistCount", label: "Watchlist", meaning: "Lead rows with lifecycle === WATCHLIST." },
      { id: "rejectedOrArchivedCount", label: "Rejected or archived", meaning: "Lead rows with lifecycle === REJECTED or ARCHIVED." },
    ],
    sections: [{ id: "byLifecycle", title: "Leads by lifecycle stage" }],
    limitations: ["Bounded to the first page listLeads returns (see maxRows) - a scope with more Leads than that is reported truncated."],
    artifactFormats: ["pdf", "xlsx", "csv"],
    executionSupport: "full",
    maxRows: 200,
  },
  partner_portfolio: {
    reportId: "partner_portfolio",
    version: 1,
    title: "Partner Portfolio",
    purpose: "Partner status/tier/region portfolio counts from the Partners service.",
    sourceModules: ["partners"],
    requiredSourceFeatures: ["partners"],
    recordScopeNote: "Rows are exactly the actor-scoped Partner rows listPartners already returns for the applied filters - no Partner outside the actor's own scope is ever included.",
    supportedFilters: [{ id: "status", type: "status", label: "Partner status" }],
    metrics: [
      { id: "partnerCount", label: "Partners in scope", meaning: "Count of actor-scoped Partner rows returned by listPartners for the applied filters." },
      { id: "activeCount", label: "Active", meaning: "Partner rows with status === ACTIVE." },
      { id: "blacklistedCount", label: "Blacklisted", meaning: "Partner rows with status === BLACKLISTED." },
      { id: "pendingAccountSetupCount", label: "Pending Partner Account setup", meaning: "Partner rows with pendingPartnerAccountSetup === true." },
    ],
    sections: [{ id: "byStatus", title: "Partners by status" }],
    limitations: ["Bounded to the first page listPartners returns (see maxRows) - a scope with more Partners than that is reported truncated."],
    artifactFormats: ["pdf", "xlsx", "csv"],
    executionSupport: "full",
    maxRows: 200,
  },
  administration_security: {
    reportId: "administration_security",
    version: 1,
    title: "Administration & Security",
    purpose: "Safe, label-only user/role/access-grant summary from the Administration service - no secret, token or raw auth internal ever leaves this report.",
    sourceModules: ["administration"],
    requiredSourceFeatures: ["administration"],
    recordScopeNote: "Rows are exactly the AdminUserDto rows listUsers already returns to this actor (Administration's own feature access already limits this to actors holding the administration feature grant - Super Admin only in the current seed).",
    supportedFilters: [{ id: "status", type: "status", label: "Active/inactive" }],
    metrics: [
      { id: "userCount", label: "Users in scope", meaning: "Count of AdminUserDto rows returned by listUsers for the applied filters." },
      { id: "activeUserCount", label: "Active users", meaning: "Users with active === true." },
      { id: "byRoleCount", label: "Users by role", meaning: "Count of users per role, from the same already-safe AdminUserDto.role field." },
    ],
    sections: [{ id: "byRole", title: "Users by role" }],
    limitations: ["No raw Firebase uid, session token, password, or override/audit before/after payload ever appears in this report - only the already-safe AdminUserDto fields (userRef, email, displayName, role, active).", "This report is only ever runnable by an actor who already holds real Administration FeatureAccess - Reports never widens who can see this data."],
    artifactFormats: ["pdf", "xlsx", "csv"],
    executionSupport: "full",
    maxRows: 200,
  },
  // ---------------------------------------------------------------------------------------------
  // Section 13 "management-scale" families - catalog entries only. None exist as real backend
  // today (only as illustrative UI-placeholder fixture names); execution is an explicit, typed
  // "not yet implemented in 19A" stub rather than fabricated computation (section 13: "do not
  // fabricate narrative topics, classifications, leaderboards or combined metrics unless explicit
  // source fields/definitions support them").
  // ---------------------------------------------------------------------------------------------
  monthly_partner_performance: {
    reportId: "monthly_partner_performance",
    version: 1,
    title: "Monthly Partner Performance",
    purpose: "A per-Partner, per-month combined Production/Compliance/Performance/Finance summary - registered as a stable catalog entry; execution is not yet implemented in 19A.",
    sourceModules: ["partner_reviews", "analytics", "finance-payables"],
    requiredSourceFeatures: [],
    recordScopeNote: "Not applicable - this report does not execute in 19A.",
    supportedFilters: [{ id: "partnerRef", type: "partnerRef", label: "Partner" }, { id: "period", type: "period", label: "Period (YYYY-MM)" }],
    metrics: [],
    sections: [],
    limitations: ["No execution in 19A: this would require a defined cross-module combination formula (Partner Review + Analytics + Finance) that does not exist yet in any source module's own schema - fabricating one here would violate section 13's own prohibition on invented combined metrics.", "Registered only so the reportId is stable and the UI-placeholder catalog row it corresponds to has a real backend id to migrate onto later."],
    artifactFormats: ["pdf", "xlsx"],
    executionSupport: "not_yet_implemented",
    maxRows: 0,
  },
  campaign_event_performance: {
    reportId: "campaign_event_performance",
    version: 1,
    title: "Campaign / Event Performance",
    purpose: "A combined Campaign delivery + native-platform outcome summary across an event's full Assignment/Content/Analytics footprint - registered as a stable catalog entry; execution is not yet implemented in 19A.",
    sourceModules: ["campaigns", "assignments", "content", "analytics"],
    requiredSourceFeatures: [],
    recordScopeNote: "Not applicable - this report does not execute in 19A.",
    supportedFilters: [{ id: "campaignRef", type: "campaignRef", label: "Campaign" }],
    metrics: [],
    sections: [],
    limitations: ["No execution in 19A: Campaign Delivery and Campaign Performance already cover their own respective sources individually (see those two families) - a genuinely NEW combined view needs its own reviewed definition of how delivery and native-platform metrics are meant to sit together, which does not exist yet.", "Registered only so the reportId is stable and the UI-placeholder catalog row it corresponds to has a real backend id to migrate onto later."],
    artifactFormats: ["pdf", "xlsx"],
    executionSupport: "not_yet_implemented",
    maxRows: 0,
  },
  cross_platform_partner_programme: {
    reportId: "cross_platform_partner_programme",
    version: 1,
    title: "Cross-Platform Partner / Programme",
    purpose: "A Partner/Programme view spanning multiple platforms with explicitly comparable (never blended) metrics - registered as a stable catalog entry; execution is not yet implemented in 19A.",
    sourceModules: ["analytics", "partners"],
    requiredSourceFeatures: [],
    recordScopeNote: "Not applicable - this report does not execute in 19A.",
    supportedFilters: [{ id: "partnerRef", type: "partnerRef", label: "Partner" }],
    metrics: [],
    sections: [],
    limitations: ["No execution in 19A: section 14 requires any combined cross-platform metric to carry its own documented definition before it can be computed - none exists yet, and Channel Growth & Freshness already covers the per-platform, non-combined view of the same underlying Analytics data.", "Registered only so the reportId is stable and the UI-placeholder catalog row it corresponds to has a real backend id to migrate onto later."],
    artifactFormats: ["pdf", "xlsx"],
    executionSupport: "not_yet_implemented",
    maxRows: 0,
  },
  long_period_partner_programme: {
    reportId: "long_period_partner_programme",
    version: 1,
    title: "Long-Period Partner Programme",
    purpose: "A multi-period (quarter/year), period-by-period verified evidence trend for a Partner Programme - registered as a stable catalog entry; execution is not yet implemented in 19A.",
    sourceModules: ["partner_reviews", "analytics", "finance-payables"],
    requiredSourceFeatures: [],
    recordScopeNote: "Not applicable - this report does not execute in 19A.",
    supportedFilters: [{ id: "partnerRef", type: "partnerRef", label: "Partner" }],
    metrics: [],
    sections: [],
    limitations: ["No execution in 19A: a period-over-period trend needs a defined multi-period aggregation window (which months/quarters roll up, how a missing period is disclosed) that does not exist in any source module's own schema yet.", "Registered only so the reportId is stable and the UI-placeholder catalog row it corresponds to has a real backend id to migrate onto later."],
    artifactFormats: ["pdf", "xlsx"],
    executionSupport: "not_yet_implemented",
    maxRows: 0,
  },
};

export function getReportDefinition(reportId: ReportId): ReportDefinition {
  return REPORT_CATALOG[reportId];
}

export function listReportDefinitions(): ReportDefinition[] {
  return Object.values(REPORT_CATALOG);
}
