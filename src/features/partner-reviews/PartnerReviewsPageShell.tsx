// Step 13B: the ONE Partner Reviews page shell for the module's Overview and Workspace - the same
// structure the approved Overview / Analytics pages render (AppShell > div.ov-page > div.head +
// the Overview | Workspace tab row), lifted into a shared wrapper so the two screens can never drift
// in frame, spacing or tab position (the 12F lesson). Server-safe: no state, no effects.
import type { ReactNode } from "react";

import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";

export const PARTNER_REVIEWS_EYEBROW = "MEASURE & REVIEW";

const TABS = [
  { label: "Overview", href: "/partner-reviews" },
  { label: "Workspace", href: "/partner-reviews/workspace" },
];

export function PartnerReviewsPageShell({ eyebrow = PARTNER_REVIEWS_EYEBROW, title, description, actions, children }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode; children?: ReactNode }) {
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

        <ModuleTabs tabs={TABS} />

        {children}
      </div>
    </AppShell>
  );
}

// The shared access-denied variant: the SAME shell, the same neutral EmptyState.
export function PartnerReviewsAccessDenied({ title = "Partner Reviews", description = "You don't have permission to view Partner Reviews." }: { title?: string; description?: string }) {
  return (
    <PartnerReviewsPageShell title={title}>
      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panelbody">
          <EmptyState title="Access denied" description={description} icon="lock" />
        </div>
      </section>
    </PartnerReviewsPageShell>
  );
}

// The detail-style frame (Review Detail, Partner-wise history): no module tab row and no `ov-page`
// wrapper - exactly like every other module's detail page (AppShell > .head ...).
export function PartnerReviewsDetailFrame({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
