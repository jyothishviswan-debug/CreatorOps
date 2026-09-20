// Step 12F: the ONE Analytics page shell. It is exactly the structure the
// approved Overview / Instagram / YouTube pages already rendered -
//   AppShell > div.ov-page > div.head (eyebrow, h1, description, actions) + tab row
// - lifted into a shared wrapper so Partners, Data Explorer and Import History
// (which used to render their tab row OUTSIDE `.ov-page`, giving it a different
// page frame, spacing and position) can no longer drift from them. Server-safe:
// no state, no effects (the tab row is the client component AnalyticsTabs).
import type { ReactNode } from "react";

import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";

import { AnalyticsTabs } from "./AnalyticsTabs";

export const ANALYTICS_EYEBROW = "MEASURE & REVIEW";

export function AnalyticsPageShell({ eyebrow = ANALYTICS_EYEBROW, title, description, actions, children }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <AppShell>
      <div className="ov-page">
        <div className="head">
          <div>
            <div className="eyebrow">{eyebrow}</div>
            <h1>{title}</h1>
            {description && <p>{description}</p>}
          </div>
          {actions}
        </div>

        <AnalyticsTabs />

        {children}
      </div>
    </AppShell>
  );
}

// The shared access-denied variant: the SAME shell (so the denied state has the
// same frame and tab row as the allowed page), the same neutral EmptyState.
export function AnalyticsAccessDenied({ title, description = "You don't have permission to view Analytics data." }: { title: string; description?: string }) {
  return (
    <AnalyticsPageShell title={title}>
      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panelbody">
          <EmptyState title="Access denied" description={description} icon="lock" />
        </div>
      </section>
    </AnalyticsPageShell>
  );
}
