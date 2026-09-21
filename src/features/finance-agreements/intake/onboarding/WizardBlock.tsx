import type { ReactNode } from "react";

import { StatusChip } from "../../components/StatusChip";
import type { ChipSpec } from "../../format";

// One step of the new-counterparty wizard: a headed group inside the wizard's section (h3 under the section's h2), with a stable anchor so the
// right-hand checklist can jump to it and focus can be moved to its heading. Accepted classes and inline style only.
export function WizardBlock({ anchorId, number, title, description, chip, children }: { anchorId: string; number: number; title: string; description?: string; chip?: ChipSpec; children: ReactNode }) {
  const titleId = `${anchorId}-title`;
  return (
    <div id={anchorId} role="group" aria-labelledby={titleId} data-testid={anchorId} style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--line)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: description ? 4 : 12 }}>
        <h3 id={titleId} tabIndex={-1} style={{ margin: 0, outline: "none" }}>
          {number}. {title}
        </h3>
        {chip && <StatusChip chip={chip} />}
      </div>
      {description && <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 12px" }}>{description}</p>}
      {children}
    </div>
  );
}

export const VISUALLY_HIDDEN = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)" } as const;
