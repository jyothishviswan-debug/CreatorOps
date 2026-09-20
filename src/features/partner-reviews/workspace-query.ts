import type { WorkspaceFilter, WorkspaceSignal } from "@/server/partner-reviews/ui-params";

// The Workspace's URL-state shape and its query-string form (the one place it is built for the load-more API).
export type WorkspaceQueryState = {
  filter: WorkspaceFilter | null;
  signal: WorkspaceSignal | null;
  // The month exactly as requested in the URL (null = none: the server defaults to the latest review month).
  month: string | null;
  partnerRef: string | null;
  region: string[];
};

export function workspaceQueryString(state: WorkspaceQueryState & { cursor?: string; limit?: number }): string {
  const search = new URLSearchParams();
  if (state.filter) search.set("filter", state.filter);
  if (state.signal) search.set("signal", state.signal);
  if (state.month) search.set("month", state.month);
  if (state.partnerRef) search.set("partnerRef", state.partnerRef);
  for (const region of state.region) search.append("region", region);
  if (state.cursor) search.set("cursor", state.cursor);
  if (state.limit) search.set("limit", String(state.limit));
  const text = search.toString();
  return text ? `?${text}` : "";
}
