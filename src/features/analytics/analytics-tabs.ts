import type { ModuleTab } from "@/ui/ModuleTabs";

// Step 12D: the ONE canonical Analytics sub-navigation, shared by all five
// Analytics pages (Overview, Instagram, YouTube, Data Explorer, Import
// History) so the tab bar can never drift between them. The Instagram and
// YouTube entries are the separate platform views; there is no second
// sidebar item and no import entry here - Import execution stays in Import
// Center only (the Overview's and Import History's own "Import data" links
// to /imports?module=analytics are unchanged).
export const ANALYTICS_TABS: ModuleTab[] = [
  { label: "Overview", href: "/analytics" },
  { label: "Instagram", href: "/analytics/instagram" },
  { label: "YouTube", href: "/analytics/youtube" },
  { label: "Data Explorer", href: "/analytics/explorer" },
  { label: "Import History", href: "/analytics/import-history" },
];
