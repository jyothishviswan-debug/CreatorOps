"use client";

// Step 14B intake, section 7 `Performance targets`: a panel of its own, apart from the payment-affecting terms. Every target is
// monitoring only: affectsPayment is always false and there is no control anywhere that could change that.
import { fieldsInSubsection, unresolvedCount } from "../field-view-model";
import { TARGET_MONITORING_LABEL, type ChipSpec } from "../format";
import { FieldRow } from "./editors/FieldRow";
import { MonitoringOnly } from "./editors/StructuredEditors";
import { useIntake } from "./intake-context";
import { SectionCard } from "./SectionCard";

const LIST_STYLE = { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 } as const;

export function PerformanceTargetsSection() {
  const { fields } = useIntake();
  const models = fieldsInSubsection(fields.performance_targets, "targets");
  const open = unresolvedCount(models);
  const chip: ChipSpec = { label: TARGET_MONITORING_LABEL, tone: "gray" };

  return (
    <SectionCard
      sectionKey="performance_targets"
      description="Targets the Agreement sets for follower growth, Reach, Views, Engagement and other Analytics-backed metrics. They are watched, never applied to any amount."
      chip={chip}
    >
      {open > 0 && <p className="foundationnote">If the Agreement sets no targets, choose Not applicable.</p>}
      {models.map((model) => (
        <FieldRow
          key={model.fieldKey}
          fieldKey={model.fieldKey}
          hint="Each target is a minimum to reach. It is recorded for monitoring only."
          renderLines={(lines) => (
            <ul style={LIST_STYLE} aria-label="Performance targets">
              {lines.map((line, index) => (
                <li key={index} style={{ display: "grid", gap: 2, overflowWrap: "anywhere" }}>
                  <span style={{ fontSize: 12 }}>{line}</span>
                  <MonitoringOnly />
                </li>
              ))}
            </ul>
          )}
        />
      ))}
    </SectionCard>
  );
}
