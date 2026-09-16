// Canonical feature identifiers - one per top-level module in the Step 3B
// skeleton. Every protected route maps to exactly one of these; access to
// a feature is always an explicit per-role grant (see capabilities.ts),
// never derived from anything else.
export const FEATURES = [
  "dashboard",
  "discovery",
  "partners",
  "vendors",
  "campaigns",
  "assignments",
  "content",
  "analytics",
  "partner_reviews",
  "finance",
  "operations",
  "reports",
  "imports",
  "exports",
  "administration",
] as const;

export type FeatureId = (typeof FEATURES)[number];

export function isFeatureId(value: unknown): value is FeatureId {
  return typeof value === "string" && (FEATURES as readonly string[]).includes(value);
}

// Shared display labels - matches the wording already used in the global
// nav (src/ui/nav-items.ts). Not a secret; safe to import from client code.
export const FEATURE_LABELS: Record<FeatureId, string> = {
  dashboard: "Dashboard",
  discovery: "Discovery",
  partners: "Partners",
  vendors: "Vendors",
  campaigns: "Campaigns",
  assignments: "Assignments",
  content: "Content",
  analytics: "Analytics",
  partner_reviews: "Partner Reviews",
  finance: "Finance",
  operations: "Operations",
  reports: "Reports",
  imports: "Import Center",
  exports: "Export Center",
  administration: "Administration",
};

// Route path -> feature mapping, longest/most-specific prefix wins.
// /foundation is intentionally absent: it's a static design reference
// with no real data, gated by authentication alone (see proxy.ts), not
// by a feature grant.
const ROUTE_FEATURE_MAP: { prefix: string; feature: FeatureId }[] = [
  { prefix: "/dashboard", feature: "dashboard" },
  { prefix: "/discovery", feature: "discovery" },
  { prefix: "/partners", feature: "partners" },
  { prefix: "/vendors", feature: "vendors" },
  { prefix: "/campaigns", feature: "campaigns" },
  { prefix: "/assignments", feature: "assignments" },
  { prefix: "/content", feature: "content" },
  { prefix: "/analytics", feature: "analytics" },
  { prefix: "/partner-reviews", feature: "partner_reviews" },
  { prefix: "/finance", feature: "finance" },
  { prefix: "/operations", feature: "operations" },
  { prefix: "/reports", feature: "reports" },
  { prefix: "/imports", feature: "imports" },
  { prefix: "/exports", feature: "exports" },
  { prefix: "/administration", feature: "administration" },
];

// Returns null for routes that aren't feature-gated at all (public paths,
// /foundation, unknown paths) - callers must treat null as "no feature
// check applies here", not as "allow".
export function getFeatureForPath(pathname: string): FeatureId | null {
  for (const { prefix, feature } of ROUTE_FEATURE_MAP) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return feature;
  }
  return null;
}
