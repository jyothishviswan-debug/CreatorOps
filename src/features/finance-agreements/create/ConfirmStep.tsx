"use client";

// EXECUTE_HARD_RESET Section 22: Step 5 - Confirm. A concise review summary, not another full form. Actions
// follow the Foundation button hierarchy: Save Draft / Confirm Agreement / Activate Agreement (never enabled
// with blockers remaining).
import { commercialIssues } from "../agreement-intake-logic/editors/commercial-logic";
import { useIntake } from "../agreement-intake-logic/intake-context";
import { buildReadiness, buildReviewGroups, draftResolver, frozenResolver } from "../agreement-intake-logic/review-summary";
import { fieldLabel } from "../format";

export function ConfirmStep({ onGoToStep }: { onGoToStep: (anchorId: string) => void }) {
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
    saveDraft,
    confirmAgreement,
    activateAgreement,
    confirmBlockers,
    isBusy,
    notify,
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
  const readiness = buildReadiness({ unresolved: unresolvedFields, localEdits, commercialIssues: commercialIssues(resolve) });

  return (
    <section className="panel">
      <div className="panelhead">
        <h2>Confirm</h2>
        <p>A concise summary before confirming.</p>
      </div>
      <div className="panelbody">
        {groups.map((group) => (
          <div key={group.key} style={{ marginBottom: 16 }}>
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
        ))}

        {readiness.length > 0 && (
          <div className="scopebox">
            <b>
              {readiness.length} item{readiness.length === 1 ? "" : "s"} need attention before this Agreement can be confirmed.
            </b>
            <ul style={{ marginTop: 8 }}>
              {readiness.map((item) => (
                <li key={item.anchorId}>
                  <button type="button" className="btn ghost" onClick={() => onGoToStep(item.anchorId)}>
                    {item.message}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {confirmBlockers.length > 0 && (
          <div className="scopebox" style={{ marginTop: 12 }}>
            <b>Confirmation blocked:</b>
            <ul style={{ marginTop: 8 }}>
              {confirmBlockers.map((blocker, i) => (
                <li key={i}>{blocker.message}</li>
              ))}
            </ul>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
          <button type="button" className="btn" disabled={isBusy() || !flags.canEdit} onClick={() => void saveDraft().then((outcome) => notify(outcome.ok ? "success" : "error", outcome.message))}>
            Save Draft
          </button>
          {!version.confirmed && (
            <button type="button" className="btn primary" disabled={isBusy() || !flags.canConfirm || readiness.length > 0} onClick={() => void confirmAgreement()}>
              Confirm Agreement
            </button>
          )}
          {flags.canActivate && (
            <button type="button" className="btn primary" disabled={isBusy()} onClick={() => void activateAgreement()}>
              Activate Agreement
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
