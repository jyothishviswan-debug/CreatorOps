"use client";

// Step 14C.3, IA section 6 "Performance targets" - separate from payment-affecting Agreement terms. Every target is
// monitoring only: affectsPayment is always false and there is no control anywhere that could change that.
import { fieldsInSubsection, unresolvedCount } from "../field-view-model";
import { TARGET_MONITORING_LABEL, type ChipSpec } from "../format";
import { useIntake } from "../agreement-intake-logic/intake-context";

import { FieldRow } from "./FieldRow";
import { SectionCard } from "./SectionCard";

export function PerformanceTargetsSection() {
  const { fields } = useIntake();
  const models = fieldsInSubsection(fields.performance_targets, "targets");
  const open = unresolvedCount(models);
  const chip: ChipSpec = { label: TARGET_MONITORING_LABEL, tone: "gray" };

  return (
    <SectionCard sectionKey="targets" title="Performance targets" description="Targets the Agreement sets for follower growth, reach, views and similar metrics. Watched only - never applied to any amount.">
      <div style={{ marginBottom: 6 }}>{open > 0 && <p className="foundationnote">If the Agreement sets no targets, choose Not applicable.</p>}</div>
      {models.map((model) => (
        <FieldRow key={model.fieldKey} fieldKey={model.fieldKey} hint="Each target is a minimum to reach, for monitoring only." />
      ))}
      {chip && (
        <p className="foundationnote" style={{ marginTop: 10 }}>
          {chip.label}
        </p>
      )}
    </SectionCard>
  );
}
