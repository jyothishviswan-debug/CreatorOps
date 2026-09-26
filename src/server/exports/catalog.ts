import type { ExportTargetDefinition, ExportTargetId } from "./types";

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
    maxRows: 500,
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
    maxRows: 500,
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
    limitations: ["Bounded to the first page listAssignments returns (see maxRows) - a scope with more Assignments than that is reported truncated."],
    maxRows: 500,
  },
};

export function getExportTargetDefinition(targetId: ExportTargetId): ExportTargetDefinition {
  return EXPORT_CATALOG[targetId];
}

export function listExportTargetDefinitions(): ExportTargetDefinition[] {
  return Object.values(EXPORT_CATALOG);
}
