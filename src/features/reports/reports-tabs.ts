import type { ModuleTab } from "@/ui/ModuleTabs";

// Step 19B: Reports sibling navigation - the governed catalog, and the acting user's own finalized
// report snapshot history (section 15). No Export Center tab (out of scope for this step).
export const REPORTS_TABS: ModuleTab[] = [
  { label: "Catalog", href: "/reports", activePrefixes: ["/reports/campaign_delivery", "/reports/campaign_performance", "/reports/channel_growth_freshness", "/reports/partner_review_evidence", "/reports/finance_status", "/reports/operations_attention", "/reports/discovery_funnel", "/reports/partner_portfolio", "/reports/administration_security", "/reports/monthly_partner_performance", "/reports/campaign_event_performance", "/reports/cross_platform_partner_programme", "/reports/long_period_partner_programme"] },
  { label: "Your finalized reports", href: "/reports/snapshots" },
];
