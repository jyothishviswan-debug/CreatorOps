// Step 12F: the ONE server page implementation behind /analytics/partners.
// Renders inside the shared AnalyticsPageShell (AppShell > `ov-page` > head + the
// shared six-tab row), exactly like Overview / Instagram / YouTube - and, like
// them, the same "Access denied" EmptyState pattern for an actor without
// Analytics (or Partners) access.
//
// All state lives in the URL (?partners, ?month, ?platform, ?targetAudience,
// ?region, ?metric). The raw search params are handed to the trusted service,
// which parses, bounds and re-validates every value on every render; nothing is
// trusted from the browser. There is deliberately NO Import CTA and no import
// execution of any kind.
import { resolveRequestActor } from "@/server/analytics/http";
import { getPartnersWorkspace } from "@/server/analytics/partners-workspace-service";
import type { WorkspaceParamsInput } from "@/server/analytics/partners-workspace-params";

import { AnalyticsPartnersWorkspace } from "./AnalyticsPartnersWorkspace";
import { AnalyticsAccessDenied, AnalyticsPageShell } from "./AnalyticsPageShell";

export async function PartnersAnalyticsPage({ params }: { params: WorkspaceParamsInput }) {
  const actor = await resolveRequestActor();
  const result = await getPartnersWorkspace(actor, params);

  if (!result.ok) return <AnalyticsAccessDenied title="Partners Analytics" />;

  return (
    <AnalyticsPageShell title="Partners Analytics" description="Choose the Partners you want to inspect, then see how they performed in a reporting month - source-reported, per Partner, never blended.">
      <AnalyticsPartnersWorkspace view={result.data} />
    </AnalyticsPageShell>
  );
}
