"use client";

// Step 14C.3: the Foundation `.formsection` archetype (h2 + p, then children) - the one frame every Agreement-form
// section renders inside. `sectionKey` gives the section its scroll anchor and focus target.
import type { ReactNode } from "react";

import { Pill } from "@/ui/Badge";

import { agreementFormAnchorId, type AgreementFormSectionKey } from "../agreement-intake-logic/agreement-form-progress";
import type { PillTone } from "../format";

export function SectionCard({ sectionKey, title, description, chip, children }: { sectionKey: AgreementFormSectionKey; title: string; description: string; chip?: { label: string; tone: PillTone }; children: ReactNode }) {
  const anchorId = agreementFormAnchorId(sectionKey);
  return (
    <section className="formsection" aria-labelledby={`${anchorId}-title`} id={anchorId} data-testid={`agreement-form-${sectionKey}`}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
        <h2 id={`${anchorId}-title`} tabIndex={-1}>
          {title}
        </h2>
        {chip && <Pill tone={chip.tone === "default" ? undefined : chip.tone}>{chip.label}</Pill>}
      </div>
      <p>{description}</p>
      {children}
    </section>
  );
}
