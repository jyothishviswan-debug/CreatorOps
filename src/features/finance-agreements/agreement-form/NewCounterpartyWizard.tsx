"use client";

// FINAL_EXECUTION Section 12 - "Create new Partner/Vendor from Agreement": extract first, duplicate check, then a
// deliberate Use existing / Continue creating new decision. All logic in agreement-intake-logic/onboarding/*; this
// file is presentation only, built fresh on the Foundation `.record`/`.field`/`.grid` archetypes.
import { Button } from "@/ui/Button";
import { Pill } from "@/ui/Badge";

import { candidateCards } from "../agreement-intake-logic/onboarding/duplicate-rules";
import type { IntakeOnboarding } from "../agreement-intake-logic/onboarding/use-onboarding";
import { accountFieldKey } from "../agreement-intake-logic/onboarding/wizard-form";

export function NewCounterpartyWizard({ onboarding }: { onboarding: IntakeOnboarding }) {
  const { state, gates, type, pickFile, extractPreview, edit, checkDuplicates, chooseExisting, continueNew, setAcknowledged, setReason, create, outcomeView, startAgain } = onboarding;

  if (outcomeView) {
    return (
      <div className="scopebox" style={{ marginTop: 16 }}>
        <b>{outcomeView.title}</b>
        <p style={{ marginTop: 6 }}>{outcomeView.message}</p>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          {outcomeView.canStartAgain && (
            <Button variant="ghost" onClick={startAgain}>
              Start again
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div className="field">
        <label>Signed Agreement (PDF)</label>
        <input type="file" accept="application/pdf" disabled={state.file !== null} onChange={(event) => pickFile(event.target.files?.[0] ?? null)} />
        {state.fileError && (
          <small style={{ color: "var(--red)" }}>{state.fileError}</small>
        )}
        {state.file && (
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
            <span className="muted">{state.file.name}</span>
            <Button disabled={!gates.canPreview} onClick={() => void extractPreview()}>
              Extract proposed record
            </Button>
          </div>
        )}
      </div>

      <div className="grid" style={{ marginTop: 14 }}>
        <div className="s6 field">
          <label>{type === "PARTNER" ? "Partner name" : "Vendor name"}</label>
          <input value={state.form.displayName} onChange={(event) => edit("displayName", event.target.value)} />
        </div>
        <div className="s6 field">
          <label>Legal name</label>
          <input value={state.form.legalName} onChange={(event) => edit("legalName", event.target.value)} />
        </div>
        <div className="s6 field">
          <label>Email</label>
          <input value={state.form.email} onChange={(event) => edit("email", event.target.value)} />
        </div>
        <div className="s6 field">
          <label>Phone</label>
          <input value={state.form.phone} onChange={(event) => edit("phone", event.target.value)} />
        </div>
        {state.form.accounts.map((account, index) => (
          <div key={index} className="s6 field">
            <label>{account.platform} handle / URL</label>
            <input value={account.locator} onChange={(event) => edit(accountFieldKey(index, "locator"), event.target.value)} placeholder="@handle or profile URL" />
          </div>
        ))}
      </div>

      {gates.issues.length > 0 && state.showIssues && (
        <ul style={{ marginTop: 10 }}>
          {gates.issues.map((issue) => (
            <li key={issue.field} style={{ color: "var(--red)", fontSize: 11 }}>
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      <div style={{ marginTop: 14 }}>
        <Button variant="primary" disabled={!gates.canCheck} onClick={() => void checkDuplicates()}>
          Check for duplicates
        </Button>
      </div>

      {gates.duplicates && (
        <div style={{ marginTop: 16 }}>
          {gates.duplicates.status === "none" && <p className="muted">No matching {type === "PARTNER" ? "Partner" : "Vendor"} found - safe to create new.</p>}
          {gates.duplicates.strongMatchOutsideYourAccess && <p style={{ color: "var(--red)" }}>A strong match exists outside your access. Ask an admin before creating a new record.</p>}
          <div className="grid">
            {candidateCards(gates.duplicates).map((candidate) => (
              <div key={candidate.ref} className="s6">
                <button
                  type="button"
                  className="record"
                  style={{ width: "100%", textAlign: "left", cursor: "pointer", opacity: candidate.inactive ? 0.6 : 1 }}
                  onClick={() => chooseExisting(candidate.ref)}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <b>{candidate.displayName}</b>
                    <Pill tone={candidate.strength === "STRONG" ? "orange" : "gray"}>{candidate.strengthLabel}</Pill>
                  </div>
                  <p className="muted" style={{ marginTop: 4 }}>
                    {candidate.regionsText}
                  </p>
                  <p className="muted" style={{ marginTop: 4, fontSize: 10 }}>
                    {candidate.signals.join(" · ")}
                  </p>
                </button>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {state.decision.kind === "USE_EXISTING" ? (
              <Pill tone="blue">Using existing record</Pill>
            ) : (
              <>
                <Button variant={state.decision.kind === "CREATE_NEW" ? "primary" : "default"} onClick={continueNew}>
                  Continue creating new
                </Button>
                {state.decision.kind === "CREATE_NEW" && gates.duplicates.candidates.some((c) => c.strength === "STRONG") && (
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11 }}>
                    <input type="checkbox" checked={state.decision.acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                    I checked the possible matches above and this is genuinely a new record.
                  </label>
                )}
              </>
            )}
          </div>
          {state.decision.kind === "CREATE_NEW" && (
            <div className="field" style={{ marginTop: 10, maxWidth: 420 }}>
              <label>Reason (internal)</label>
              <input value={state.decision.reason} onChange={(event) => setReason(event.target.value)} placeholder="Why this is a new record" />
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <Button variant="primary" disabled={!gates.canCreate || state.create.status === "running"} onClick={() => void create()}>
          {state.decision.kind === "USE_EXISTING" ? "Use existing and start draft" : "Create and start draft"}
        </Button>
        {gates.createBlockedReason && (
          <p className="muted" style={{ marginTop: 6 }}>
            {gates.createBlockedReason}
          </p>
        )}
      </div>
    </div>
  );
}
