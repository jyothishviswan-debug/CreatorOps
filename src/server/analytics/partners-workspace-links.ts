// Step 12F: the ONE place a Partners workspace URL is written. Deliberately
// import-free at runtime (type-only imports, no server module) so the interactive
// client selector can build the very same URLs the server renders - the URL is the
// one source of truth and the server re-validates every value on every render.
import type { TargetAudience } from "@/server/discovery/types";

export const PARTNERS_WORKSPACE_PATH = "/analytics/partners";
export const DEFAULT_TREND_METRIC = "engagement";

export type WorkspaceHrefState = {
  partnerRefs: readonly string[];
  // The user's own explicit month (null = follow the latest month with data).
  month: string | null;
  platform: "all" | "instagram" | "youtube";
  targetAudience: readonly TargetAudience[];
  regions: readonly string[];
  metric: "views" | "engagement" | "likes" | "comments";
};

// Only non-default values are carried: All platform and the default metric are
// absent; `month` only when it is the user's explicit choice (so a default month
// keeps following the data). Only already-validated values are passed in.
export function partnersWorkspacePath(state: WorkspaceHrefState): string {
  const params = new URLSearchParams();
  if (state.partnerRefs.length > 0) params.set("partners", state.partnerRefs.join(","));
  if (state.month) params.set("month", state.month);
  if (state.platform !== "all") params.set("platform", state.platform);
  for (const value of state.targetAudience) params.append("targetAudience", value);
  for (const value of state.regions) params.append("region", value);
  if (state.metric !== DEFAULT_TREND_METRIC) params.set("metric", state.metric);
  const query = params.toString();
  return query ? `${PARTNERS_WORKSPACE_PATH}?${query}` : PARTNERS_WORKSPACE_PATH;
}
