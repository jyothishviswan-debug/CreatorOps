import { ModuleTabs } from "@/ui/ModuleTabs";

import { ANALYTICS_TABS } from "./analytics-tabs";

// Step 12F: the ONE Analytics tab-row component contract. Every Analytics page
// (and its access-denied variant) renders this via AnalyticsPageShell, so the
// six tabs share exactly one component, one constant and one DOM - identical to
// the approved Overview / Instagram / YouTube treatment.
export function AnalyticsTabs() {
  return <ModuleTabs tabs={ANALYTICS_TABS} scrollActiveIntoView />;
}
