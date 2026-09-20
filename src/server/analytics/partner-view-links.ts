// Step 12E: the ONE place the Partner Analytics drill-down's hrefs are built.
// Pure and dependency-free (no server imports), so the trusted services, the
// pure DTO builders and the tests all share it and a link can never drift.
//
// Every href here is a same-origin PATH the actor may follow only because the
// service that emitted it already proved the corresponding access (Analytics
// explore gate + live Partner Record Scope). The encoded ref inside an href is
// the same canonical partnerRef the Partner profile route already carries in
// its URL (/partners/[partnerId]); it is never emitted as a bare field.
import type { PlatformViewId } from "./platform-view-metrics";

export const PARTNER_ANALYTICS_BASE_PATH = "/analytics/partner";

// /analytics/partner/<partnerRef>[?platform=instagram|youtube]. The bare path
// is the `All` view; a platform is only ever carried when one is selected.
export function partnerAnalyticsPath(partnerRef: string, platform?: PlatformViewId | "all" | null): string {
  const base = `${PARTNER_ANALYTICS_BASE_PATH}/${encodeURIComponent(partnerRef)}`;
  return platform && platform !== "all" ? `${base}?platform=${platform}` : base;
}

// The canonical Partner profile route (unchanged, never replaced).
export function partnerProfilePath(partnerRef: string): string {
  return `/partners/${encodeURIComponent(partnerRef)}`;
}

// Data Explorer deep link. Only query parameters the Explorer page genuinely
// honors are ever emitted: `platform`, `recordKind`, `partnerRef`,
// `partnerAccountRef` (see src/app/analytics/explorer/page.tsx).
export function partnerExplorerPath(input: { partnerRef?: string; partnerAccountRef?: string; platform?: PlatformViewId | "all" | null; recordKind?: "content" | "channel" }): string {
  const params = new URLSearchParams();
  if (input.platform && input.platform !== "all") params.set("platform", input.platform);
  params.set("recordKind", input.recordKind ?? "content");
  if (input.partnerRef) params.set("partnerRef", input.partnerRef);
  if (input.partnerAccountRef) params.set("partnerAccountRef", input.partnerAccountRef);
  return `/analytics/explorer?${params.toString()}`;
}
