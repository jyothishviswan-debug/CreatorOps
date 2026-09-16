// Canonical global navigation. Group structure follows the golden master
// (RELATIONSHIPS / EXECUTION / INTELLIGENCE / OPERATIONS / GOVERNANCE), with
// module names updated to CreatorOps' final terminology:
//   Partner = individual creator/influencer
//   Vendor  = agency/manager/representative/payee/business entity
//   Content = production/review/publication record
//   Partner Reviews = production / compliance / performance review
import type { IconName } from "./icons";
import type { FeatureId } from "@/server/authz/features";

export type NavItem = {
  label: string;
  href: string;
  icon: IconName;
  // Every nav item maps to exactly one authorization feature id, used to
  // filter the nav against the signed-in actor's explicit grants (see
  // GlobalSidebar.tsx). Purely presentational - the server independently
  // re-checks feature access on every route regardless of nav visibility.
  feature: FeatureId;
};

export type NavGroup = {
  label: string | null;
  items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [{ label: "Dashboard", href: "/dashboard", icon: "grid", feature: "dashboard" }],
  },
  {
    label: "RELATIONSHIPS",
    items: [
      { label: "Discovery", href: "/discovery", icon: "search", feature: "discovery" },
      { label: "Partners", href: "/partners", icon: "users", feature: "partners" },
      { label: "Vendors", href: "/vendors", icon: "brief", feature: "vendors" },
    ],
  },
  {
    label: "EXECUTION",
    items: [
      { label: "Campaigns", href: "/campaigns", icon: "flag", feature: "campaigns" },
      { label: "Assignments", href: "/assignments", icon: "check", feature: "assignments" },
      { label: "Content", href: "/content", icon: "file", feature: "content" },
    ],
  },
  {
    label: "INTELLIGENCE",
    items: [
      { label: "Analytics", href: "/analytics", icon: "chart", feature: "analytics" },
      { label: "Partner Reviews", href: "/partner-reviews", icon: "layers", feature: "partner_reviews" },
    ],
  },
  {
    label: "OPERATIONS",
    items: [
      { label: "Finance", href: "/finance", icon: "wallet", feature: "finance" },
      { label: "Operations", href: "/operations", icon: "clock", feature: "operations" },
      { label: "Reports", href: "/reports", icon: "file", feature: "reports" },
      { label: "Import Center", href: "/imports", icon: "upload", feature: "imports" },
      { label: "Export Center", href: "/exports", icon: "download", feature: "exports" },
    ],
  },
  {
    label: "GOVERNANCE",
    items: [{ label: "Administration", href: "/administration", icon: "shield", feature: "administration" }],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);
