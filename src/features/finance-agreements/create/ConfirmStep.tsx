"use client";

// FINAL_BUILD_PROMPT Section 9: Screen 5 - Confirm, as three balanced logical columns (left: Agreement Document /
// Parties / KYC Status; center: Key Information / Commercial Terms / Content & Platforms / Performance Targets;
// right: Agreement Summary, lifecycle, blockers and the primary action) instead of one long scrolling list.
// Every row's underlying data is the same buildReviewGroups() output already used before - only the layout and
// the addition of a compact summary card and real lifecycle copy are new. Lifecycle text uses ONLY the Agreement
// domain's actual statuses (DRAFT / confirmed-not-yet-active / ACTIVE) - Section 9 explicitly forbids inventing
// stages ("internal review", "signed upload", ...) the backend does not have.
import { Icon } from "@/ui/icons";

import { commercialIssues } from "../agreement-intake-logic/editors/commercial-logic";
import { useIntake } from "../agreement-intake-logic/intake-context";
import { buildReadiness, buildReviewGroups, draftResolver, frozenResolver, type ReviewGroup } from "../agreement-intake-logic/review-summary";
import { fieldLabel } from "../format";

import { groupReadinessByStep } from "./agreement-create-adapter";
import styles from "./AgreementCreatePage.module.css";
import type { AgreementCreateStep } from "./agreement-create-view";

function rowText(group: ReviewGroup | undefined, label: string): string | null {
  return group?.rows.find((row) => row.label === label)?.text ?? null;
}

function ReviewGroupPanel({ group }: { group: ReviewGroup }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3>{group.title}</h3>
        {group.chip && <span className={`pill${group.chip.tone === "default" ? "" : ` ${group.chip.tone}`}`}>{group.chip.label}</span>}
      </div>
      <div style={{ marginTop: 6 }}>
        {group.rows.map((row) => (
          <div key={row.label} className="kv" style={{ gridTemplateColumns: "160px 1fr" }}>
            <span>{row.label}</span>
            <b>{row.text}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ConfirmStep({ onGoToStep }: { onGoToStep: (step: AgreementCreateStep) => void }) {
  const {
    hasDraft,
    version,
    counterparty,
    artifact,
    extraction,
    extractionAttached,
    unresolvedCount,
    unresolvedFields,
    kyc,
    localEdits,
    fieldModels,
    flags,
    confirmAgreement,
    activateAgreement,
    confirmBlockers,
    isBusy,
  } = useIntake();
  if (!hasDraft || !version) return null;

  const resolve = version.confirmed ? frozenResolver(version) : draftResolver(fieldModels, localEdits);
  const groups = buildReviewGroups({
    counterparty,
    version: { confirmed: version.confirmed, sourceMode: version.sourceMode },
    resolve,
    models: fieldModels,
    artifact,
    extractionStatus: extraction?.run.status ?? null,
    extractionAttached,
    unresolvedCount,
    kyc,
    fieldLabel,
  });
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const readiness = buildReadiness({ unresolved: unresolvedFields, localEdits, commercialIssues: commercialIssues(resolve) });
  const readinessByStep = groupReadinessByStep(readiness);

  const lifecycle = version.confirmed ? (version.status === "ACTIVE" ? { label: "Active", tone: "default" as const } : { label: "Confirmed · not yet active", tone: "blue" as const }) : { label: "Draft · not yet confirmed", tone: "gray" as const };

  return (
    <section className="panel">
      <div className="panelhead">
        <h2>Confirm</h2>
        <p>Review all details and confirm to create the Agreement. You can go back and edit any section if needed.</p>
      </div>
      <div className="panelbody">
        {readiness.length === 0 && confirmBlockers.length === 0 && !version.confirmed && (
          <div className="banner" style={{ marginBottom: 20 }}>
            <Icon name="check" />
            <span>
              <b>Agreement ready to create.</b> All required information is complete. Please review the details below and confirm.
            </span>
          </div>
        )}

        <div className={styles.confirmGrid}>
          <div>
            {byKey.has("artifact") && <ReviewGroupPanel group={byKey.get("artifact")!} />}
            {byKey.has("counterparty") && <ReviewGroupPanel group={byKey.get("counterparty")!} />}
            {byKey.has("kyc") && <ReviewGroupPanel group={byKey.get("kyc")!} />}
          </div>

          <div>
            {byKey.has("dates") && <ReviewGroupPanel group={byKey.get("dates")!} />}
            {byKey.has("scope") && <ReviewGroupPanel group={byKey.get("scope")!} />}
            {byKey.has("terms") && <ReviewGroupPanel group={byKey.get("terms")!} />}
            {byKey.has("targets") && <ReviewGroupPanel group={byKey.get("targets")!} />}
          </div>

          <div>
            <div className="scopebox" style={{ marginBottom: 16 }}>
              <b>Agreement Summary</b>
              <div style={{ marginTop: 8 }}>
                {[
                  ["Counterparty", rowText(byKey.get("counterparty"), byKey.get("counterparty")?.rows[0]?.label ?? "")],
                  ["Platforms", rowText(byKey.get("scope"), "Platforms") ?? rowText(byKey.get("scope"), "Scope")],
                  ["Payment cycle", rowText(byKey.get("terms"), fieldLabel("paymentCycle"))],
                  ["Incentive", rowText(byKey.get("terms"), fieldLabel("incentive"))],
                  ["Effective period", rowText(byKey.get("dates"), "Effective period")],
                  ["KYC readiness", rowText(byKey.get("kyc"), "Status")],
                  ["Unresolved decisions", String(unresolvedCount)],
                ]
                  .filter(([, text]) => text !== null)
                  .map(([label, text]) => (
                    <div key={label} className="kv" style={{ gridTemplateColumns: "130px 1fr" }}>
                      <span>{label}</span>
                      <b>{text}</b>
                    </div>
                  ))}
              </div>
            </div>

            <div className="scopebox" style={{ marginBottom: 16 }}>
              <b>Post-creation</b>
              <p style={{ marginTop: 6 }}>
                <span className={`pill${lifecycle.tone === "default" ? "" : ` ${lifecycle.tone}`}`}>{lifecycle.label}</span>
              </p>
              <p style={{ marginTop: 8 }}>
                {version.confirmed
                  ? flags.canActivate
                    ? "Confirmed terms are frozen. Activate when the Agreement is ready to govern real work."
                    : "Confirmed terms are frozen."
                  : "The Agreement will be created in Draft status. You can review, edit or confirm it before activating."}
              </p>
              <div className={styles.lifecycleList}>
                {[
                  { label: "Agreement created (Draft)", state: version.confirmed ? "done" : "current" },
                  { label: "Confirmed", state: version.confirmed ? "done" : "upcoming" },
                  { label: "Active", state: version.status === "ACTIVE" ? "done" : version.confirmed && flags.canActivate ? "current" : "upcoming" },
                ].map((stage) => (
                  <div key={stage.label} className={`${styles.lifecycleStep} ${styles[stage.state]}`}>
                    <span className={styles.lifecycleDot} />
                    {stage.label}
                  </div>
                ))}
              </div>
            </div>

            {readiness.length > 0 && (
              <div className="scopebox" style={{ marginBottom: 16 }}>
                <b>
                  {readiness.length} item{readiness.length === 1 ? "" : "s"} need attention before this Agreement can be confirmed.
                </b>
                <div style={{ marginTop: 4 }}>
                  {readinessByStep.map((group) => (
                    <button key={group.step} type="button" className="attention" onClick={() => onGoToStep(group.step)}>
                      <span className="alerttile">
                        <Icon name="alert" />
                      </span>
                      <span className="grow">
                        <strong>{group.title}</strong>
                        <small>
                          {group.items.length} item{group.items.length === 1 ? "" : "s"} need{group.items.length === 1 ? "s" : ""} a decision
                        </small>
                      </span>
                      <span className="count">{group.items.length}</span>
                      <span className="arrow">→</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {confirmBlockers.length > 0 && (
              <div className="scopebox" style={{ marginBottom: 16 }}>
                <b>Confirmation blocked:</b>
                <ul style={{ marginTop: 8 }}>
                  {confirmBlockers.map((blocker, i) => (
                    <li key={i}>{blocker.message}</li>
                  ))}
                </ul>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {/* Save as draft already lives in the shared header for every step; only the readiness-gated
                  primary action stays here, next to the readiness list that explains it. */}
              {!version.confirmed && (
                <button type="button" className="btn primary" disabled={isBusy() || !flags.canConfirm || readiness.length > 0} onClick={() => void confirmAgreement()}>
                  Create Agreement
                </button>
              )}
              {flags.canActivate && (
                <button type="button" className="btn primary" disabled={isBusy()} onClick={() => void activateAgreement()}>
                  Activate Agreement
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
