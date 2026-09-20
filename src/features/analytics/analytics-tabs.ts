import type { ModuleTab } from "@/ui/ModuleTabs";

// Step 12F: the ONE canonical Analytics sub-navigation - six first-class,
// equal tabs shared by every Analytics page (Overview, Instagram, YouTube,
// Partners, Data Explorer, Import History) and the Partner drill-down, so the
// tab bar can never drift between them. No grouping, no separator, no extra
// gap before the last two. There is no second sidebar item and no import entry
// here - Import execution stays in Import Center only (the Overview's and
// Import History's own "Import data" links to /imports?module=analytics are
// unchanged).
//
// `/analytics/partner/<ref>` (the single-Partner drill-down) is not a tab of
// its own: it declares Partners as its parent, so the same six-tab row shows
// Partners as the current context there.
export const ANALYTICS_PARTNER_DETAIL_PREFIX = "/analytics/partner/";

export const ANALYTICS_TABS: ModuleTab[] = [
  { label: "Overview", href: "/analytics" },
  { label: "Instagram", href: "/analytics/instagram" },
  { label: "YouTube", href: "/analytics/youtube" },
  { label: "Partners", href: "/analytics/partners", activePrefixes: [ANALYTICS_PARTNER_DETAIL_PREFIX] },
  { label: "Data Explorer", href: "/analytics/explorer" },
  { label: "Import History", href: "/analytics/import-history" },
];
