import { OUTREACH_CHANNELS, type AssetDecisionKind, type LeadEventKind, type LeadLifecycle, type OutreachChannel, type ReviewOutcome } from "@/server/discovery/types";

export { relativeTime, absoluteTime } from "@/features/administration/format";

// Display labels only - the canonical lifecycle values themselves are
// never altered or re-derived here (see authz/lifecycle.ts).
export const LIFECYCLE_LABELS: Record<LeadLifecycle, string> = {
  NEW: "New",
  RESEARCHING: "Researching",
  CONTACTED: "Contacted",
  RESPONDED: "Responded",
  EVALUATING: "Evaluating",
  CONVERSION_READY: "Conversion ready",
  CONVERTED: "Converted",
  WATCHLIST: "Watchlist",
  REJECTED: "Rejected",
  DUPLICATE: "Duplicate",
  ARCHIVED: "Archived",
};

export function lifecycleTone(lifecycle: LeadLifecycle): "default" | "orange" | "blue" | "purple" | "red" | "gray" {
  if (lifecycle === "CONVERTED") return "default";
  if (lifecycle === "CONVERSION_READY") return "blue";
  if (lifecycle === "REJECTED" || lifecycle === "DUPLICATE") return "red";
  if (lifecycle === "WATCHLIST" || lifecycle === "ARCHIVED") return "gray";
  if (lifecycle === "NEW") return "gray";
  return "orange";
}

// Finding #16 (user-decided): business-meaning labels, not the raw wire
// enum - centralized here (previously a local, non-exported const in
// stages.tsx, which is why ReadyConvertedStages.tsx's conversion dialog
// used to print the raw enum instead - finding #14). Wire values
// themselves are unchanged, only what a human sees changed.
export const ASSET_DECISION_LABELS: Record<AssetDecisionKind, string> = {
  NEW_ACCOUNT: "New Account",
  MAINTAIN_EXISTING: "Maintain",
  TRANSFER_AND_MAINTAIN: "Ownership Transfer & Maintain",
};

export const ASSET_DECISION_DESCRIPTIONS: Record<AssetDecisionKind, string> = {
  NEW_ACCOUNT: "A new account will be created for operation.",
  MAINTAIN_EXISTING: "The Partner/Vendor already has the account and continues operating it for us - compensation can apply under the Agreement.",
  TRANSFER_AND_MAINTAIN: "The Partner/Vendor already has the account; ownership transfers to us and they continue maintaining it - an ownership-transfer fee may apply under the Agreement.",
};

// Defensive fallback for any value outside the known union (shouldn't be
// reachable - AssetDecisionKind is a closed Zod enum - but the raw
// backend enum must never leak to the UI even if it somehow is).
export function assetDecisionLabel(decision: string): string {
  return (ASSET_DECISION_LABELS as Record<string, string>)[decision] ?? "Unknown decision";
}

// Finding #7 (user-decided): the closed set NEW Outreach attempts choose from, plus a safe fallback
// for any already-stored value outside it (old free-text data, or anything pre-dating this enum).
export const CHANNEL_LABELS: Record<OutreachChannel, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  call: "Phone call",
  other: "Other",
};
export const CHANNEL_OPTIONS = OUTREACH_CHANNELS.map((value) => ({ value, label: CHANNEL_LABELS[value] }));

export function channelLabel(channel: string): string {
  return (CHANNEL_LABELS as Record<string, string>)[channel] ?? channel;
}

export const REVIEW_OUTCOME_LABELS: Record<ReviewOutcome, string> = {
  SHORTLIST: "Shortlist",
  NEED_MORE_INFO: "Need more information",
  WATCHLIST: "Watch list",
  REJECT: "Reject",
};

const EVENT_LABELS: Record<LeadEventKind, string> = {
  created: "Lead created",
  edited: "Lead details edited",
  lifecycle_transitioned: "Lifecycle changed",
  lifecycle_restored: "Lead restored",
  research_saved: "Research saved",
  review_recorded: "Review recorded",
  outreach_recorded: "Outreach recorded",
  commercial_saved: "Commercial evidence saved",
  agreement_saved: "Agreement evidence saved",
  asset_decision_saved: "Asset decision saved",
  manager_assigned: "Manager assignment changed",
  owner_assigned: "Owner reassigned",
  kyc_updated: "KYC package updated",
  duplicate_checked: "Duplicate check run",
  converted: "Converted to Partner",
};

export function eventLabel(kind: LeadEventKind): string {
  return EVENT_LABELS[kind] ?? kind;
}
