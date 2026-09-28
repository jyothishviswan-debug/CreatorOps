import type { FeatureId } from "@/server/authz/features";

// Shared client-side shape of GET /api/me's response (see that route's own comment: a safe,
// enforcement-irrelevant presentation DTO only). Factored out of GlobalSidebar.tsx so AppShell.tsx
// can fetch it once and hand the same value to both GlobalSidebar and Topbar, instead of each doing
// its own independent fetch.
export type MeResponse =
  | { authenticated: false }
  | { authenticated: true; role: string; displayName: string; activeFeatures: FeatureId[] };
