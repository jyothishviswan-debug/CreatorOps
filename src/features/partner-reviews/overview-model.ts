import type { OverviewPanelData } from "@/features/shared/types";
import type { IconName } from "@/ui/icons";
import type { PartnerReviewsOverviewDto } from "@/server/partner-reviews/partner-review-overview-service";
import { reviewHref, workspaceHref, type WorkspaceSignal } from "@/server/partner-reviews/ui-params";

import { EVENT_LABELS, relativeTime, SIGNAL_LABELS } from "./format";

// Step 13B: the PURE builder of the Partner Reviews Overview composition, so the
// approved layout is unit-asserted rather than eyeballed.
//
// Source of truth for the composition: docs/reference/CreatorOps_UI_Golden_Master.html,
// OV_DATA["creator-reviews"] (OV_MODULE_TO_KEY maps the old "productivity" module to it):
//   4 KPI cards; top row = 3 panels (columns / donut / donut) of span 4;
//   bottom row = 4 panels (distribution / attention / activity / actions) of span 3.
// The composition is STRUCTURALLY FROZEN: real data is mapped into these exact slots -
// no panel is added, removed or reordered, no span or row count changes, and no other
// metric is ever substituted into a slot. Where a slot's meaning depends on data that
// does not exist (a monthly requirement without an Agreement policy) the slot stays and
// reads "Unavailable". Canonical terminology replaces the golden master's old wording
// (Creator Reviews -> Partner Reviews, Deliverable -> Content).

export const OVERVIEW_EYEBROW = "MEASURE & REVIEW";
export const OVERVIEW_TITLE = "Partner Reviews";
export const OVERVIEW_DESCRIPTION = "Review monthly production, compliance and performance independently.";

export const KPI_LABELS = ["Monthly reviews", "Assignments received", "Qualifying content", "Finalized reviews"] as const;
export const TOP_PANEL_TITLES = ["Production Summary", "Submission Timeliness", "Performance Evidence"] as const;
export const BOTTOM_PANEL_TITLES = ["Review Lifecycle", "Needs Attention", "Recent Activity", "Quick Actions"] as const;
export const QUICK_ACTION_LABELS = ["Review queue", "Draft / in review", "Finalized history", "Open workspace"] as const;

export type OverviewModel = {
  kpis: { icon: IconName; label: string; value: string; hint: string }[];
  topPanels: OverviewPanelData[];
  bottomPanels: OverviewPanelData[];
  // The Needs Attention rows' real destinations, keyed by row title.
  attentionLinks: Record<string, string>;
  chips: string[];
  banner: { title: string; description: string };
};

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// The neutral "nothing to draw" donut form the accepted modules already use (never a zero ring).
function neutralDonut(icon: IconName, title: string, note: string, foot: string, span: number, segmentLabel: string): OverviewPanelData {
  return { kind: "donut", icon, title, note, foot, span, total: 1, totalLabel: "Not available", segments: [{ label: segmentLabel, value: 0 }] };
}

export function buildOverviewModel(data: PartnerReviewsOverviewDto): OverviewModel {
  const { counts, month, disclosure } = data;
  const monthReady = month.resolved !== null;
  const reviews = counts.monthlyReviews;
  const monthNote = month.label ?? "No review months yet";

  // --- KPIs -----------------------------------------------------------------------------------
  const requirementComplete = reviews > 0 && counts.reviewsWithRequirement === reviews;
  const qualifyingHint = requirementComplete
    ? `of ${counts.requiredTotal} required`
    : counts.reviewsWithRequirement > 0
      ? `Requirement supplied for ${counts.reviewsWithRequirement} of ${reviews} reviews`
      : "Requirement unavailable";

  const kpis: OverviewModel["kpis"] = monthReady
    ? [
        { icon: "file", label: KPI_LABELS[0], value: String(reviews), hint: monthNote },
        { icon: "check", label: KPI_LABELS[1], value: String(counts.assignmentsReceived), hint: "by due date, else created date" },
        { icon: "flag", label: KPI_LABELS[2], value: String(counts.qualifyingContent), hint: qualifyingHint },
        { icon: "shield", label: KPI_LABELS[3], value: String(counts.finalizedReviews), hint: `of ${plural(reviews, "monthly review")}` },
      ]
    : [
        { icon: "file", label: KPI_LABELS[0], value: "—", hint: monthNote },
        { icon: "check", label: KPI_LABELS[1], value: "—", hint: "Not yet available" },
        { icon: "flag", label: KPI_LABELS[2], value: "—", hint: "Not yet available" },
        { icon: "shield", label: KPI_LABELS[3], value: "—", hint: "Not yet available" },
      ];

  // --- Top row: 4 / 4 / 4 --------------------------------------------------------------------------
  const production: OverviewPanelData = {
    kind: "columns",
    icon: "file",
    title: TOP_PANEL_TITLES[0],
    note: "Content · overlapping workflow stages",
    foot: !monthReady
      ? "No review month yet."
      : requirementComplete
        ? `${plural(counts.assignmentsReceived, "assignment")} received · ${counts.requiredTotal} content items required by policy.`
        : `${plural(counts.assignmentsReceived, "assignment")} received · no complete monthly requirement is supplied, so Required is unavailable.`,
    span: 4,
    rows: [
      { label: "Required", value: requirementComplete ? counts.requiredTotal : 0, unavailable: !requirementComplete },
      { label: "Under review", value: counts.production.underReview },
      { label: "Approved", value: counts.production.approved },
      { label: "Completed assignments", value: counts.production.completedAssignments },
    ],
  };

  const submitted = counts.timeliness.onTime + counts.timeliness.late;
  const timelinessNote =
    submitted > 0
      ? `${plural(submitted, "submission")} with a known due date${counts.timeliness.unknownTiming > 0 ? ` · ${counts.timeliness.unknownTiming} with unknown timing, not counted as late` : ""}`
      : counts.timeliness.unknownTiming > 0
        ? `${plural(counts.timeliness.unknownTiming, "submission")} with unknown timing, not counted as late`
        : "No submissions with recorded timing yet";
  const timeliness: OverviewPanelData =
    monthReady && submitted > 0
      ? {
          kind: "donut",
          icon: "clock",
          title: TOP_PANEL_TITLES[1],
          note: timelinessNote,
          foot: "Timing uses the recorded first submission and due instant · compliance stays separate.",
          span: 4,
          total: submitted,
          totalLabel: "Submitted",
          segments: [
            { label: "On time", value: counts.timeliness.onTime },
            { label: "Late", value: counts.timeliness.late },
          ],
        }
      : neutralDonut("clock", TOP_PANEL_TITLES[1], timelinessNote, "A missing timestamp is not automatically late · compliance stays separate.", 4, "No timing evidence yet");

  const performanceTotal = counts.performance.available + counts.performance.stale + counts.performance.missing;
  const performance: OverviewPanelData =
    monthReady && performanceTotal > 0
      ? {
          kind: "donut",
          icon: "chart",
          title: TOP_PANEL_TITLES[2],
          note: `${plural(performanceTotal, "monthly Partner review")} · no composite score`,
          foot: "Stale = behind upstream at the last recorded check. Missing is not zero and not failed. Performance is evidence-based, never a composite score.",
          span: 4,
          total: performanceTotal,
          totalLabel: "Reviews",
          segments: [
            { label: "Available", value: counts.performance.available },
            { label: "Stale", value: counts.performance.stale },
            { label: "Missing", value: counts.performance.missing },
          ],
        }
      : neutralDonut("chart", TOP_PANEL_TITLES[2], "No monthly Partner reviews yet · no composite score", "Performance is evidence-based, never a composite score.", 4, "Not yet available");

  // --- Bottom row: 3 / 3 / 3 / 3 ---------------------------------------------------------------------
  const lifecycleTotal = counts.lifecycle.needsReview + counts.lifecycle.draftInReview + counts.lifecycle.finalized;
  const lifecycle: OverviewPanelData =
    monthReady && lifecycleTotal > 0
      ? {
          kind: "donut",
          icon: "layers",
          title: BOTTOM_PANEL_TITLES[0],
          note: counts.candidates > 0 ? `${plural(reviews, "monthly review")} + ${plural(counts.candidates, "Partner-month")} awaiting a first review` : plural(reviews, "monthly review"),
          foot: "Exclusive states: a review behind upstream counts once, under Needs review. Needs review is derived, never stored.",
          span: 3,
          total: lifecycleTotal,
          totalLabel: "Reviews",
          segments: [
            { label: "Needs review", value: counts.lifecycle.needsReview },
            { label: "Draft / in review", value: counts.lifecycle.draftInReview },
            { label: "Finalized", value: counts.lifecycle.finalized },
          ],
        }
      : neutralDonut("layers", BOTTOM_PANEL_TITLES[0], "No monthly reviews or review candidates yet", "Needs review is derived, never stored.", 3, "Not yet available");

  // Only real, non-zero, actionable categories - never forced.
  const attentionLinks: Record<string, string> = {};
  const attentionRows: { title: string; detail: string; count: string }[] = [];
  const addAttention = (count: number, title: string, detail: string, href: string) => {
    if (count <= 0) return;
    attentionRows.push({ title, detail, count: String(count) });
    attentionLinks[title] = href;
  };
  const monthQuery = month.resolved;
  const signalHref = (signal: WorkspaceSignal) => workspaceHref({ signal, month: monthQuery });
  addAttention(counts.attention.staleEvidence, SIGNAL_LABELS.stale, "Refresh", signalHref("stale"));
  addAttention(counts.attention.revisionAvailable, SIGNAL_LABELS.revision_available, "Revise", signalHref("revision_available"));
  addAttention(counts.attention.missingEvidence, SIGNAL_LABELS.missing_evidence, "Check", signalHref("missing_evidence"));
  addAttention(counts.attention.lateSubmissions, SIGNAL_LABELS.late, "Review", signalHref("late"));
  addAttention(counts.attention.draftReviews, "Draft reviews", "Continue", workspaceHref({ filter: "drafts", month: monthQuery }));
  addAttention(counts.attention.requirementUnavailable, SIGNAL_LABELS.requirement_unavailable, "Check", signalHref("requirement_unavailable"));
  addAttention(counts.attention.lfcSfcUnavailable, SIGNAL_LABELS.lfc_sfc_unavailable, "Check", signalHref("lfc_sfc_unavailable"));
  addAttention(counts.attention.targetNotMet, SIGNAL_LABELS.target_not_met, "Review", signalHref("target_not_met"));

  const attention: OverviewPanelData = {
    kind: "attention",
    icon: "alert",
    title: BOTTOM_PANEL_TITLES[1],
    note: attentionRows.length > 0 ? "Separate review dimensions" : "Nothing needs attention right now",
    foot: "Counts use stored evidence and the last recorded freshness check. Production, compliance and performance remain independent.",
    span: 3,
    rows: attentionRows,
  };

  const activity: OverviewPanelData = {
    kind: "activity",
    icon: "clock",
    title: BOTTOM_PANEL_TITLES[2],
    note: "Latest meaningful changes",
    foot: data.activity.length > 0 ? "Full history stays in the workspace." : "No Partner Review activity yet.",
    span: 3,
    rows: data.activity.map((entry) => ({
      title: EVENT_LABELS[entry.kind],
      detail: `${entry.partnerDisplayName ?? "Partner"} · ${relativeTime(entry.at)}`,
      href: reviewHref(entry.reviewRef),
    })),
  };

  const actions: OverviewPanelData = {
    kind: "actions",
    icon: "grid",
    title: BOTTOM_PANEL_TITLES[3],
    note: "Continue from insight to action",
    foot: "Every action opens the real workspace with its filter applied.",
    span: 3,
    rows: [
      { label: QUICK_ACTION_LABELS[0], icon: "search", href: workspaceHref({ filter: "needs-review", month: monthQuery }) },
      { label: QUICK_ACTION_LABELS[1], icon: "file", href: workspaceHref({ filter: "drafts", month: monthQuery }) },
      { label: QUICK_ACTION_LABELS[2], icon: "check", href: workspaceHref({ filter: "finalized", month: monthQuery }) },
      { label: QUICK_ACTION_LABELS[3], icon: "grid", href: workspaceHref({ month: monthQuery }) },
    ],
  };

  // --- Banner / disclosure chips -------------------------------------------------------------------------
  const chips = ["Authorized scope preview", monthReady ? (month.source === "explicit" ? `${month.label} · selected` : `${month.label} · latest review month`) : "No review months yet"];
  if (disclosure.headsTruncated) chips.push(`Showing the first ${disclosure.headsRead} reviews of the month`);
  if (disclosure.assignmentScanTruncated) chips.push(`Needs review found in the most recent ${disclosure.assignmentsScanned} Assignments`);
  if (counts.summaryUnavailableReviews > 0) chips.push(`${plural(counts.summaryUnavailableReviews, "review")} without a stored summary`);

  return {
    kpis,
    topPanels: [production, timeliness, performance],
    bottomPanels: [lifecycle, attention, activity, actions],
    attentionLinks,
    chips,
    banner: {
      title: "Monthly review intelligence",
      description: monthReady
        ? "What is happening, what needs attention, and where to act next. Freshness reflects the last recorded check, not a live comparison."
        : "Reviews appear here once a Partner-month has a review or in-period Assignments.",
    },
  };
}
