import type { ReactNode } from "react";

import { StatusChip } from "../components/StatusChip";
import type { ChipSpec } from "../format";
import { INTAKE_SECTIONS, intakeSectionAnchor, type IntakeSectionKey } from "./intake-progress";

// Step 14B intake: the ONE section wrapper - the accepted `section.formsection` (h2 + helper) with a stable anchor id, so every intake
// section (mine and the other agent's) is a jump target for blockers and the progress checklist. `chip` is an optional status text.
// Rendered inside `form.panel` by IntakeForm; it adds no styling of its own.
export function SectionCard({ sectionKey, title, description, chip, children }: { sectionKey: IntakeSectionKey; title?: string; description?: string; chip?: ChipSpec; children: ReactNode }) {
  const meta = INTAKE_SECTIONS.find((section) => section.key === sectionKey)!;
  const id = intakeSectionAnchor(sectionKey);
  const titleId = `${id}-title`;
  return (
    <section className="formsection" id={id} aria-labelledby={titleId} data-testid={`intake-${sectionKey}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: description ? 4 : 18 }}>
        <h2 id={titleId} tabIndex={-1} style={{ margin: 0, outline: "none" }}>
          {title ?? meta.title}
        </h2>
        {chip && <StatusChip chip={chip} />}
      </div>
      {description && <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 18px" }}>{description}</p>}
      {children}
    </section>
  );
}
