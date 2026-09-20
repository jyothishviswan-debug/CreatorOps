// Step 12F: the actor-safe DTO of the Partners Analytics workspace plus the PURE
// builder that composes it from already-loaded, already-scoped inputs. No I/O
// here (partners-workspace-service.ts loads the documents and records).
//
// Actor-safety: the analysis parts of the DTO (month, coverage, single Partner
// view, comparison, matrices, links) carry display labels, numbers, dates and
// same-origin HREFS only - no raw uid, no bare *Ref field, no Firestore path, no
// post/media URL and no restricted Partner profile field (a Partner is its
// display name alone). The ONE exception is the selector contract
// (`selector.selected[].ref` / `selector.state.partnerRefs`): the canonical
// partnerRefs the actor themselves put in the URL and the server has just
// re-validated live (feature + Partner Record Scope), needed so the interactive
// selector can add / remove a Partner. They are never rendered as text.
import type { TargetAudience } from "@/server/discovery/types";

import { partnerAnalyticsPath } from "./partner-view-links";
import type { PartnerAnalyticsViewDto, PartnerPlatformSwitchItem } from "./partner-view-dto";
import { PARTNER_VIEW_SELECTIONS, platformLabelOf, platformsForSelection, type PartnerViewSelection } from "./partner-view-metrics";
import { PLATFORM_VIEW_METRIC_LABELS, PLATFORM_VIEW_METRICS, type PlatformViewMetricId } from "./platform-view-metrics";
import { partnersWorkspacePath, PARTNER_SELECTION_LIMIT, type WorkspaceState } from "./partners-workspace-params";
import {
  availableMonthsOf,
  buildComparisonRow,
  buildTrendMatrices,
  coverageSummaryText,
  exclusionsOf,
  hasMonthData,
  restrictWindowToSelection,
  type ComparisonDto,
  type PartnerRecordWindow,
  type TrendMatrixDto,
} from "./partners-workspace-metrics";
import { buildMonthOptions, describeExclusions, monthLabel, resolveMonth, type MonthExclusions, type MonthOption } from "./reporting-month";

// A Partner as the selector shows it: SAFE display identity only.
export type SelectedPartnerDto = { ref: string; displayName: string; regions: string[]; targetAudience: TargetAudience[] };
export type PartnerSearchResultDto = SelectedPartnerDto;

export type WorkspaceMonthDto = {
  // The month the workspace is rendered for; null = no reporting month with data yet.
  resolved: string | null;
  label: string | null;
  source: "explicit" | "latest_default" | "none";
  // Human wording of `source`.
  sourceLabel: string;
  // Up to the latest 12 months with data (newest first) + the explicit month when it has none.
  options: MonthOption[];
};

export type WorkspaceCoverageDto = {
  // "4 of 6 selected Partners have Analytics data for August 2026" (null = nothing selected / no month).
  text: string | null;
  selectedCount: number;
  withDataCount: number;
  // Records that can never be placed in a month, per reason (never forced into one).
  exclusions: MonthExclusions;
  exclusionNote: string | null;
  // The bounded read stopped early somewhere (Partners' windows or the no-selection scan).
  truncatedNote: string | null;
};

export type WorkspaceMetricSwitchItem = { metric: PlatformViewMetricId; label: string; href: string; active: boolean };

export type PartnersWorkspaceDto = {
  selector: {
    selected: SelectedPartnerDto[];
    limit: number;
    // The validated URL state the client rebuilds URLs from.
    state: {
      partnerRefs: string[];
      month: string | null;
      platform: PartnerViewSelection;
      targetAudience: TargetAudience[];
      regions: string[];
      metric: PlatformViewMetricId;
    };
  };
  platform: PartnerViewSelection;
  month: WorkspaceMonthDto;
  coverage: WorkspaceCoverageDto;
  // Neutral, existence-free notices (unavailable Partners, over-limit, invalid month).
  notices: string[];
  links: {
    platformSwitch: PartnerPlatformSwitchItem[];
    // Only in comparison mode: which ONE metric the trend matrix shows.
    metricSwitch: WorkspaceMetricSwitchItem[] | null;
    // Only with exactly ONE selected Partner.
    openFullPartnerHref: string | null;
    clearSelectionHref: string;
  };
  mode: "empty" | "single" | "comparison";
  single: PartnerAnalyticsViewDto | null;
  comparison: {
    table: ComparisonDto;
    metric: PlatformViewMetricId;
    metricLabel: string;
    matrices: TrendMatrixDto[];
    matrixNote: string;
  } | null;
};

export const TRUNCATION_DISCLOSURE = "Showing a bounded window of the most recent scoped source records - some older months or records may not be included.";

export function unavailablePartnersNotice(count: number): string {
  return `${count} selected Partner${count === 1 ? " is" : "s are"} not available`;
}

export function overLimitNotice(count: number): string {
  return `Only the first ${PARTNER_SELECTION_LIMIT} selected Partners are shown; ${count} more ${count === 1 ? "was" : "were"} ignored`;
}

export const INVALID_MONTH_NOTICE = "The month in the link is not a valid reporting month, so the latest reporting month with data is shown instead";

export type BuildWorkspaceParams = {
  state: WorkspaceState;
  // Live-loaded, scope-checked Partners in SELECTION order.
  selected: { ref: string; displayName: string; regions: string[]; targetAudience: TargetAudience[] }[];
  // How many requested Partners were dropped (unknown, out of scope, malformed): neutral.
  unavailableCount: number;
  // ONE bounded, platform-filtered window per selected Partner (same order as `selected`).
  windows: PartnerRecordWindow[];
  // The context windows the month list / default derive from: the selected Partners'
  // own windows, or (nothing selected) a single Partner-linked whole-scope scan.
  contextWindows: PartnerRecordWindow[];
  // The single-Partner inline view (exactly one selected Partner), already month-filtered.
  single: PartnerAnalyticsViewDto | null;
};

export function buildPartnersWorkspaceDto(params: BuildWorkspaceParams): PartnersWorkspaceDto {
  const { state, selected, single } = params;
  // Belt and braces (the service already reads per platform): only the selected
  // platforms' records can ever be counted, whatever the caller passed.
  const windows = params.windows.map((window) => restrictWindowToSelection(window, state.platform));
  const contextWindows = params.contextWindows.map((window) => restrictWindowToSelection(window, state.platform));

  const available = availableMonthsOf(contextWindows);
  const resolution = resolveMonth(state.month, available);
  const month = resolution.month;

  const hrefState = { partnerRefs: selected.map((partner) => partner.ref), month: state.month, platform: state.platform, targetAudience: state.targetAudience, regions: state.regions, metric: state.metric };

  const comparable = selected.map((partner, index) => ({ partner, window: windows[index]! }));

  // Coverage over the selected Partners (x of y), never dropping one.
  const rows = comparable.map(({ partner, window }) =>
    buildComparisonRow({ displayName: partner.displayName, analyticsHref: partnerAnalyticsPath(partner.ref, state.platform, month), window, month, selection: state.platform }),
  );
  const withDataCount = rows.filter((row) => hasMonthData(row.coverage.state)).length;

  const anyTruncated = contextWindows.some((window) => window.truncated);
  const exclusions = exclusionsOf(contextWindows);

  const notices: string[] = [];
  const unavailable = params.unavailableCount + state.malformedPartnerTokens;
  if (unavailable > 0) notices.push(unavailablePartnersNotice(unavailable));
  if (state.ignoredOverLimit > 0) notices.push(overLimitNotice(state.ignoredOverLimit));
  if (state.monthInvalid) notices.push(INVALID_MONTH_NOTICE);

  const mode: PartnersWorkspaceDto["mode"] = selected.length === 0 ? "empty" : selected.length === 1 ? "single" : "comparison";

  const metricLabel = PLATFORM_VIEW_METRIC_LABELS[state.metric];
  const matrixMonths = available.slice(0, 12);
  const comparison: PartnersWorkspaceDto["comparison"] =
    mode === "comparison"
      ? {
          table: { viewsPlatforms: platformsForSelection(state.platform), rows },
          metric: state.metric,
          metricLabel,
          matrices: buildTrendMatrices({ partners: comparable.map(({ partner, window }) => ({ displayName: partner.displayName, window })), selection: state.platform, metric: state.metric, months: matrixMonths }),
          matrixNote:
            matrixMonths.length > 0
              ? `${metricLabel} by reporting month for the latest ${matrixMonths.length} month${matrixMonths.length === 1 ? "" : "s"} with data · each cell is one Partner's own source-reported ${metricLabel} - never combined across Partners`
              : "No reporting month with data yet",
        }
      : null;

  return {
    selector: {
      selected: selected.map((partner) => ({ ref: partner.ref, displayName: partner.displayName, regions: partner.regions, targetAudience: partner.targetAudience })),
      limit: PARTNER_SELECTION_LIMIT,
      state: { ...hrefState, partnerRefs: [...hrefState.partnerRefs], targetAudience: [...state.targetAudience], regions: [...state.regions] },
    },
    platform: state.platform,
    month: {
      resolved: month,
      label: month ? monthLabel(month) : null,
      source: resolution.source,
      sourceLabel: resolution.source === "explicit" ? "Selected month" : resolution.source === "latest_default" ? "Latest reporting month with data" : "No reporting month with data yet",
      options: buildMonthOptions(available, month),
    },
    coverage: {
      text: selected.length > 0 && month ? coverageSummaryText({ selected: selected.length, withData: withDataCount, month, platform: state.platform }) : null,
      selectedCount: selected.length,
      withDataCount,
      exclusions,
      exclusionNote: describeExclusions(exclusions),
      truncatedNote: anyTruncated ? TRUNCATION_DISCLOSURE : null,
    },
    notices,
    links: {
      platformSwitch: PARTNER_VIEW_SELECTIONS.map((item) => ({
        selection: item,
        label: item === "all" ? "All" : platformLabelOf(item),
        href: partnersWorkspacePath({ ...hrefState, platform: item }),
        active: item === state.platform,
      })),
      metricSwitch:
        mode === "comparison"
          ? PLATFORM_VIEW_METRICS.map((metric) => ({ metric, label: PLATFORM_VIEW_METRIC_LABELS[metric], href: partnersWorkspacePath({ ...hrefState, metric }), active: metric === state.metric }))
          : null,
      openFullPartnerHref: mode === "single" ? partnerAnalyticsPath(selected[0]!.ref, state.platform, month) : null,
      clearSelectionHref: partnersWorkspacePath({ ...hrefState, partnerRefs: [] }),
    },
    mode,
    single: mode === "single" ? single : null,
    comparison,
  };
}
