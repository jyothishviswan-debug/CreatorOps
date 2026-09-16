import type { ReadinessIssue } from "./api-client";
import type { LeadDto } from "@/server/discovery/client-dto";
import type { LeadLifecycle } from "@/server/discovery/types";

// Step 6B: "The visible workflow is workflow context, not a second
// lifecycle model." Each stage's done/current/future status is DERIVED
// from the real readiness endpoint's blocker codes (never recomputed in
// React) plus the canonical lifecycle value - this file never decides
// what IS or ISN'T allowed, only how to visually group what the server
// already said.
export type StageKey = "lead" | "research" | "review" | "outreach" | "agreement" | "asset" | "manager" | "ready" | "converted";

export const STAGES: { key: StageKey; label: string }[] = [
  { key: "lead", label: "Lead" },
  { key: "research", label: "Research" },
  { key: "review", label: "Review & Shortlist" },
  { key: "outreach", label: "Outreach & Negotiation" },
  { key: "agreement", label: "Agreement" },
  { key: "asset", label: "Asset Setup" },
  { key: "manager", label: "Manager & KYC" },
  { key: "ready", label: "Ready" },
  { key: "converted", label: "Converted" },
];

const ALTERNATIVE_OUTCOMES: readonly LeadLifecycle[] = ["WATCHLIST", "REJECTED", "DUPLICATE", "ARCHIVED"];

export function isAlternativeOutcome(lifecycle: LeadLifecycle): boolean {
  return ALTERNATIVE_OUTCOMES.includes(lifecycle);
}

function hasBlocker(blockers: ReadinessIssue[], code: string): boolean {
  return blockers.some((b) => b.code === code);
}

export function isStageDone(stage: StageKey, lead: LeadDto, blockers: ReadinessIssue[]): boolean {
  switch (stage) {
    case "lead":
      return !hasBlocker(blockers, "IDENTITY_CONTACT_MISSING");
    case "research":
      return !hasBlocker(blockers, "RESEARCH_INCOMPLETE");
    case "review":
      return !hasBlocker(blockers, "REVIEW_MISSING");
    case "outreach":
      return !hasBlocker(blockers, "RESPONSE_MISSING") && !hasBlocker(blockers, "COMMERCIAL_ALIGNMENT_MISSING");
    case "agreement":
      return !hasBlocker(blockers, "OPERATIONAL_AGREEMENT_MISSING");
    case "asset":
      return !hasBlocker(blockers, "ASSET_DECISION_MISSING");
    case "manager":
      return !hasBlocker(blockers, "MANAGER_MISSING") && !hasBlocker(blockers, "MANAGER_INACTIVE") && !hasBlocker(blockers, "KYC_INCOMPLETE");
    case "ready":
      return blockers.length === 0 || lead.lifecycle === "CONVERTED";
    case "converted":
      return lead.lifecycle === "CONVERTED";
  }
}

// The first not-yet-done stage, in canonical order - "current stage
// shows its action/form". When every stage is done, the last one
// (Converted) is current by construction.
export function currentStageKey(lead: LeadDto, blockers: ReadinessIssue[]): StageKey {
  for (const stage of STAGES) {
    if (!isStageDone(stage.key, lead, blockers)) return stage.key;
  }
  return "converted";
}
