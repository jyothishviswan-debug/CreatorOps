"use client";

// FINAL_EXECUTION: the one Foundation panel archetype every major working panel renders inside -
// `.panel` > `.panelhead` (h2 + description) + `.panelbody` - full width, never a narrow max-width form.
import type { ReactNode } from "react";

export function SectionCard({ title, description, testId, chip, children }: { title: string; description: string; testId?: string; chip?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel" style={{ marginBottom: 18 }} data-testid={testId ?? `agreement-panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
      <div className="panelhead">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {chip}
      </div>
      <div className="panelbody">{children}</div>
    </section>
  );
}
