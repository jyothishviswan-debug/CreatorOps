// Canonical global navigation. Group structure follows the golden master
// (RELATIONSHIPS / EXECUTION / INTELLIGENCE / OPERATIONS / GOVERNANCE), with
// module names updated to CreatorOps' final terminology:
//   Partner = individual creator/influencer
//   Vendor  = agency/manager/representative/payee/business entity
//   Content = production/review/publication record
//   Partner Reviews = production / compliance / performance review
import type { IconName } from "./icons";

export type NavItem = {
  label: string;
  href: string;
  icon: IconName;
};

export type NavGroup = {
  label: string | null;
  items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [{ label: "Dashboard", href: "/dashboard", icon: "grid" }],
  },
  {
    label: "RELATIONSHIPS",
    items: [
      { label: "Discovery", href: "/discovery", icon: "search" },
      { label: "Partners", href: "/partners", icon: "users" },
      { label: "Vendors", href: "/vendors", icon: "brief" },
    ],
  },
  {
    label: "EXECUTION",
    items: [
      { label: "Campaigns", href: "/campaigns", icon: "flag" },
      { label: "Assignments", href: "/assignments", icon: "check" },
      { label: "Content", href: "/content", icon: "file" },
    ],
  },
  {
    label: "INTELLIGENCE",
    items: [
      { label: "Analytics", href: "/analytics", icon: "chart" },
      { label: "Partner Reviews", href: "/partner-reviews", icon: "layers" },
    ],
  },
  {
    label: "OPERATIONS",
    items: [
      { label: "Finance", href: "/finance", icon: "wallet" },
      { label: "Operations", href: "/operations", icon: "clock" },
      { label: "Reports", href: "/reports", icon: "file" },
      { label: "Import Center", href: "/import-center", icon: "upload" },
      { label: "Export Center", href: "/export-center", icon: "download" },
    ],
  },
  {
    label: "GOVERNANCE",
    items: [{ label: "Administration", href: "/administration", icon: "shield" }],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);
