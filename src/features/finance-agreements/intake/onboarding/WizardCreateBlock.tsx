"use client";

// Onboarding wizard, step 4: CONFIRMED ONBOARDING VALUES and the final action. `Create Partner and start Agreement` (or `Use existing Partner and
// start Agreement`) runs the server's resumable step ledger - Validated, created, Accounts, Agreement draft - with visible progress. A failure is
// RECOVERABLE: Retry sends the same request (nothing is created twice); after a reload the wizard asks the server where it stopped.
//
// Permissions come from the server before render: a person who may review but not create sees this step disabled with the plain reason, and can
// still use an existing record. Nothing is revealed and then hidden.
import { useEffect, useRef } from "react";

import { Icon } from "@/ui/icons";

import { StatusChip } from "../../components/StatusChip";
import { DISABLED_BUTTON_STYLE } from "../../format";
import { confirmedRows, KYC_LATER_NOTE } from "./confirmed-values";
import { outcomeAnnouncement, type StepRow } from "./create-progress";
import { REQUEST_CONFLICT_CODE } from "./create-failure";
import { INTAKE_BUSY, useIntake } from "../intake-context";
import { ONBOARDING_STEP_ANCHORS } from "./onboarding-progress";
import { VISUALLY_HIDDEN, WizardBlock } from "./WizardBlock";

const STATE_TEXT: Record<StepRow["state"], string> = { done: "Done", current: "In progress", pending: "Waiting", failed: "Did not finish" };
const STATE_TONE: Record<StepRow["state"], "default" | "blue" | "gray" | "red"> = { done: "default", current: "blue", pending: "gray", failed: "red" };
const ERROR_BANNER = { margin: "12px 0 0", borderColor: "#e8c2c6", background: "#fdf6f6", color: "#8f3a42" } as const;

export function WizardCreateBlock() {
  const { onboarding, isBusy } = useIntake();
  const { state, gates, type, steps, outcomeView } = onboarding;
  const noun = type === "PARTNER" ? "Partner" : "Vendor";
  const busy = isBusy();
  const running = state.create.status === "running" || isBusy(INTAKE_BUSY.onboardCreate);
  const decision = gates.decision;
  const alertRef = useRef<HTMLDivElement>(null);

  const outcome = state.create.status === "outcome" ? state.create.outcome : null;
  const showValues = gates.duplicates !== null && decision.kind !== "NONE";
  // A refusal means nothing ran (it is refused before anything is written): a list of steps all reading `Waiting` beside `Nothing was created` would only confuse.
  const showProgress = running || (state.create.status !== "idle" && state.create.status !== "refused");
  const announcement = outcomeAnnouncement(outcome, running);

  // A failure (assertive alert) takes focus once, so a keyboard / screen-reader user lands on it and its Retry.
  const failureKey = state.create.status === "outcome" ? `${state.create.outcome.outcome}:${state.create.outcome.failedStep ?? ""}` : state.create.status === "refused" || state.create.status === "error" ? state.create.status : "";
  useEffect(() => {
    if (failureKey === "" || failureKey.startsWith("COMPLETED") || failureKey.startsWith("IN_PROGRESS")) return;
    alertRef.current?.focus();
  }, [failureKey]);

  const label =
    decision.kind === "USE_EXISTING" ? `Use existing ${noun} and start Agreement` : `Create ${noun} and start Agreement`;
  const disabled = busy || !gates.canCreate;
  const showDisabledReason = !gates.canCreate && !gates.locked && gates.createBlockedReason;

  return (
    <WizardBlock anchorId={ONBOARDING_STEP_ANCHORS.create} number={4} title="Confirm and start the Agreement" description="The values below are exactly what will be created. You can still go back and change them.">
      {showValues && (
        <div data-testid="onboarding-confirmed-values">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", columnGap: 24 }}>
            {confirmedRows({ type, form: state.form, decision, duplicates: gates.duplicates }).map((row) => (
              <div className="kv" key={row.label}>
                <span>{row.label}</span>
                <b style={{ minWidth: 0, overflowWrap: "anywhere", fontWeight: row.muted ? 400 : undefined }}>{row.muted ? <span className="muted">{row.value}</span> : row.value}</b>
              </div>
            ))}
          </div>
          <p className="foundationnote" style={{ marginTop: 10 }}>
            {KYC_LATER_NOTE}
          </p>
        </div>
      )}
      {!showValues && !showProgress && <p className="foundationnote" style={{ marginTop: 0 }}>{gates.createBlockedReason ?? "Finish the steps above to confirm the values."}</p>}

      {state.resume.status === "checking" && (
        <p role="status" className="muted" style={{ fontSize: 11 }}>
          Checking where your earlier attempt stopped…
        </p>
      )}

      {/* The plain reason the final step is disabled (no create right, an incomplete decision ...): always visible, never hidden behind a click. */}
      {showDisabledReason && (
        <div className="banner" role="status" style={{ margin: "12px 0 0" }} data-testid="onboarding-create-blocked">
          <span>{gates.createBlockedReason}</span>
        </div>
      )}

      {/* The action stays on screen (disabled, `Creating…`) while the request runs, so it never vanishes under the person's focus; once a request was sent and stopped, Retry / Start again (below) replace it. */}
      {(!gates.locked || running) && state.create.status !== "outcome" && (
        <div className="actions" style={{ marginTop: 14, alignItems: "center" }}>
          <button type="button" className="btn primary" onClick={() => void onboarding.create()} disabled={disabled} aria-disabled={disabled} style={disabled ? DISABLED_BUTTON_STYLE : undefined} data-testid="onboarding-create">
            {running ? "Creating…" : label}
          </button>
        </div>
      )}

      {/* Step progress + outcome: the region exists from the start so the first message is heard. */}
      <div role="status" aria-live="polite" style={announcement ? { marginTop: 12 } : VISUALLY_HIDDEN} data-testid="onboarding-create-status">
        {announcement && <small style={{ color: announcement.tone === "error" ? "#8f3a42" : undefined }}>{announcement.text}</small>}
      </div>

      {showProgress && (
        <ol aria-label="Onboarding progress" style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 8 }} data-testid="onboarding-steps">
          {steps.map((step) => (
            <li key={step.step} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }} data-step={step.step} data-state={step.state}>
              {step.state === "done" ? <Icon name="check" style={{ width: 14, height: 14, color: "var(--green)" }} /> : step.state === "failed" ? <Icon name="alert" style={{ width: 14, height: 14, color: "var(--red)" }} /> : <span aria-hidden="true" style={{ width: 14, height: 14, borderRadius: "50%", border: "1.5px solid #c3cad2", display: "inline-block" }} />}
              <span>{step.label}</span>
              <StatusChip label={STATE_TEXT[step.state]} tone={STATE_TONE[step.state]} />
            </li>
          ))}
        </ol>
      )}

      {outcome && outcomeView && outcome.outcome !== "COMPLETED" && (
        <div ref={alertRef} tabIndex={-1} className="banner" role={outcomeView.tone === "error" ? "alert" : "status"} style={{ ...(outcomeView.tone === "error" ? ERROR_BANNER : { margin: "12px 0 0" }), outline: "none", display: "block" }} data-testid="onboarding-outcome" data-outcome={outcome.outcome}>
          <b>{outcomeView.title}</b>
          <p style={{ margin: "4px 0 0" }}>{outcomeView.message}</p>
          {outcomeView.duplicateSignal && <p style={{ margin: "4px 0 0" }}>This is a strong sign that the Partner already exists.</p>}
          {outcomeView.keptRecords.length > 0 && (
            <>
              <p style={{ margin: "8px 0 0", fontSize: 11 }}>Already created (kept):</p>
              <ul style={{ margin: "2px 0 0 18px", padding: 0, fontSize: 11 }}>
                {outcomeView.keptRecords.map((record) => (
                  <li key={record}>{record}</li>
                ))}
              </ul>
            </>
          )}
          <div className="actions" style={{ marginTop: 10 }}>
            {(outcomeView.action === "RETRY" || outcomeView.action === "CHECK_AGAIN") && (
              <button type="button" className="btn primary" onClick={() => void onboarding.create()} disabled={busy} aria-disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} data-testid="onboarding-retry">
                {running ? "Working…" : outcomeView.actionLabel}
              </button>
            )}
            {outcomeView.canStartAgain && (
              <button type="button" className={outcomeView.action === "START_AGAIN" ? "btn primary" : "btn"} onClick={() => onboarding.startAgain()} disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} data-testid="onboarding-start-again">
                Change the details and start again
              </button>
            )}
          </div>
        </div>
      )}

      {outcome && outcomeView && outcome.outcome === "COMPLETED" && (
        <div className="banner" role="status" style={{ margin: "12px 0 0" }} data-testid="onboarding-outcome" data-outcome="COMPLETED">
          <span>
            <b>{outcomeView.title}.</b> {outcomeView.message}
          </span>
        </div>
      )}

      {state.create.status === "refused" && (
        <div ref={alertRef} tabIndex={-1} className="banner" role="alert" style={{ ...ERROR_BANNER, outline: "none", display: "block" }} data-testid="onboarding-refused">
          <b>Nothing was created.</b>
          <p style={{ margin: "4px 0 0" }}>{state.create.message}</p>
          {state.create.code === REQUEST_CONFLICT_CODE && (
            <div className="actions" style={{ marginTop: 10 }}>
              <button type="button" className="btn primary" onClick={() => onboarding.startAgain()} disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined}>
                Change the details and start again
              </button>
            </div>
          )}
        </div>
      )}

      {state.create.status === "error" && (
        <div ref={alertRef} tabIndex={-1} className="banner" role="alert" style={{ ...ERROR_BANNER, outline: "none", display: "block" }} data-testid="onboarding-lost">
          <b>We could not confirm the result.</b>
          <p style={{ margin: "4px 0 0" }}>{state.create.message}</p>
          <div className="actions" style={{ marginTop: 10 }}>
            <button type="button" className="btn primary" onClick={() => void onboarding.create()} disabled={busy} aria-disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} data-testid="onboarding-retry">
              {running ? "Working…" : "Retry"}
            </button>
            <button type="button" className="btn" onClick={() => onboarding.startAgain()} disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} data-testid="onboarding-start-again">
              Change the details and start again
            </button>
          </div>
        </div>
      )}
    </WizardBlock>
  );
}
