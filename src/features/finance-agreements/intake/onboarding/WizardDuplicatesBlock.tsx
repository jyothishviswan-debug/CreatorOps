"use client";

// Onboarding wizard, step 3: the DUPLICATE CHECK. `Possible existing Partner found` lists what the person may see (name, regions, why it matched,
// STRONG vs SUPPORTING) with `Use existing` per record and `Continue creating new`. A STRONG match (or a check that could not run) needs an explicit
// acknowledgement AND a reason before a new record can be created; a strong match outside the person's access, or an account that already
// belongs to a Partner, blocks creating a new one. Nothing is ever merged automatically and a name alone is only supporting evidence.
import { useEffect, useId, useRef } from "react";

import { StatusChip } from "../../components/StatusChip";
import { DISABLED_BUTTON_STYLE } from "../../format";
import { INTAKE_BUSY, useIntake } from "../intake-context";
import { clearDuplicatesResultFocusRequest, consumeDuplicatesResultFocusRequest } from "./duplicates-focus";
import { candidateCards, DUPLICATE_REASON_MAX, DUPLICATE_REASON_MIN, summarizeDuplicates } from "./duplicate-rules";
import { ONBOARDING_STEP_ANCHORS } from "./onboarding-progress";
import { VISUALLY_HIDDEN, WizardBlock } from "./WizardBlock";

export function WizardDuplicatesBlock() {
  const { onboarding, isBusy } = useIntake();
  const { state, gates, type } = onboarding;
  const noun = type === "PARTNER" ? "Partner" : "Vendor";
  const baseId = useId();
  const resultRef = useRef<HTMLDivElement>(null);
  const focusResultRef = useRef(false);

  const load = state.duplicates.load;
  const checking = load.status === "loading" || isBusy(INTAKE_BUSY.onboardDuplicates);
  const busy = isBusy();
  const locked = gates.locked;
  const result = gates.duplicates;
  // The result copy never claims "no duplicate exists" (Step 14C): see duplicate-rules.ts. It also never says a record CAN be created - a
  // review-only person is told the plain reason in step 4.
  const summary = result ? summarizeDuplicates(result) : null;
  const cards = result ? candidateCards(result) : [];
  const decision = gates.decision;
  const validForm = state.preview.status === "ready" && gates.issues.length === 0;
  const stale = load.status === "ready" && result === null;

  const resultKey = result ? result.checkedAt : null;
  useEffect(() => {
    if (!resultKey) return;
    // Moves focus to the result after a check the person started - from here (`Check again`) or from the record step's own button.
    const requestedElsewhere = consumeDuplicatesResultFocusRequest();
    if (!focusResultRef.current && !requestedElsewhere) return;
    focusResultRef.current = false;
    resultRef.current?.focus();
  }, [resultKey]);
  const failed = load.status === "error";
  useEffect(() => {
    if (failed) clearDuplicatesResultFocusRequest();
  }, [failed]);

  const recheck = async () => {
    if (busy || locked) return;
    focusResultRef.current = true;
    await onboarding.checkDuplicates();
  };

  const announcement = checking ? `Checking for an existing ${noun}…` : load.status === "error" ? `Couldn’t check for an existing ${noun}. ${load.message}` : summary ? `${summary.heading}. ${summary.message}` : null;

  return (
    <WizardBlock anchorId={ONBOARDING_STEP_ANCHORS.duplicates} number={3} title={`Check for an existing ${noun}`} description={`Before anything is created, CreatorOps looks for a ${noun} with the same email, phone or account. A name match alone is only a hint.`}>
      {/* Screen-reader announcement only: the visible outcome is the result banner below (and the error banner), so the same sentence is never printed twice. It is shown only while the check runs. */}
      <div role="status" aria-live="polite" style={announcement && checking ? { marginBottom: 8 } : VISUALLY_HIDDEN} data-testid="onboarding-duplicates-status">
        {announcement && <small className="muted">{announcement}</small>}
      </div>

      {!validForm && !result && !checking && <p className="foundationnote" style={{ marginTop: 0 }}>Complete the {noun} details above, then check for an existing {noun}.</p>}
      {validForm && !result && !checking && load.status !== "error" && (
        <p className="foundationnote" style={{ marginTop: 0 }}>
          {stale ? "The details changed since the last check. Check again before continuing." : `Not checked yet. Use “Check for existing ${noun}” above.`}
        </p>
      )}
      {checking && (
        <div aria-hidden="true">
          <div className="skeleton" style={{ width: "60%" }} />
          <div className="skeleton" style={{ width: "40%" }} />
        </div>
      )}
      {load.status === "error" && !checking && (
        <div className="banner" role="alert" style={{ margin: 0 }} data-testid="onboarding-duplicates-error">
          <span style={{ flex: 1 }}>
            <b>Couldn’t check for an existing {noun}.</b> {load.message} A new {noun} cannot be created until the check has run.
          </span>
          <button type="button" className="btn" onClick={recheck} disabled={busy || locked} style={busy || locked ? DISABLED_BUTTON_STYLE : undefined}>
            Try again
          </button>
        </div>
      )}

      {result && summary && (
        <div ref={resultRef} tabIndex={-1} style={{ outline: "none" }} data-testid="onboarding-duplicates-result" data-status={summary.kind}>
          <div className="banner" style={{ margin: 0 }}>
            <span>
              <b>{summary.heading}</b>
              <br />
              {summary.message}
            </span>
          </div>

          {summary.blockMessage && (
            <div className="banner" role="alert" style={{ margin: "10px 0 0", borderColor: "#e8c2c6", background: "#fdf6f6", color: "#8f3a42" }} data-testid="onboarding-duplicates-blocked">
              <span>
                <b>A new {noun} cannot be created.</b> {summary.blockMessage}
              </span>
            </div>
          )}

          {cards.length > 0 && (
            <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "grid", gap: 10 }} aria-label={`Possible existing ${noun} records`}>
              {cards.map((card) => {
                const chosen = decision.kind === "USE_EXISTING" && decision.ref === card.ref;
                return (
                  <li key={card.ref} style={{ border: chosen ? "1px solid var(--orange)" : "1px solid var(--line)", boxShadow: chosen ? "0 0 0 1px var(--orange)" : undefined, background: chosen ? "var(--tint)" : "#fff", borderRadius: 9, padding: "12px 14px", display: "grid", gap: 8 }} data-testid={`onboarding-candidate-${card.ref}`} data-strength={card.strength}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <b style={{ overflowWrap: "anywhere" }}>{card.displayName}</b>
                      <StatusChip label={card.strengthLabel} tone={card.strength === "STRONG" ? "orange" : "gray"} />
                      {card.inactive && <StatusChip label="Not active" tone="gray" />}
                      {chosen && <StatusChip label="Selected" tone="default" />}
                    </div>
                    <small className="muted">Region: {card.regionsText}</small>
                    <ul style={{ margin: 0, padding: "0 0 0 16px", fontSize: 11 }} aria-label="Why it matched">
                      {card.signals.map((signal) => (
                        <li key={signal}>{signal}</li>
                      ))}
                    </ul>
                    <div className="actions">
                      <button type="button" className="btn" aria-pressed={chosen} aria-label={`Use existing ${noun} ${card.displayName}`} onClick={() => (chosen ? onboarding.clearDecision() : onboarding.chooseExisting(card.ref))} disabled={busy || locked} style={busy || locked ? DISABLED_BUTTON_STYLE : undefined} data-testid={`onboarding-use-existing-${card.ref}`}>
                        {chosen ? "Using this record" : "Use existing"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {decision.kind === "USE_EXISTING" && (
            <p className="foundationnote" style={{ marginTop: 10 }}>
              The Agreement will be started for the existing {noun} you chose. No new {noun} is created.
            </p>
          )}

          {summary.kind !== "none" && !summary.blocksCreateNew && (
            <div className="actions" style={{ marginTop: 12, alignItems: "center" }}>
              <button type="button" className="btn" aria-pressed={decision.kind === "CREATE_NEW"} onClick={() => onboarding.continueNew()} disabled={busy || locked} style={busy || locked ? DISABLED_BUTTON_STYLE : undefined} data-testid="onboarding-continue-new">
                Continue creating new
              </button>
              <small className="muted">A new {noun} is created only after the last step.</small>
            </div>
          )}

          {decision.kind === "CREATE_NEW" && summary.requiresAcknowledgement && !summary.blocksCreateNew && (
            <div style={{ display: "grid", gap: 12, marginTop: 14, maxWidth: 560 }} data-testid="onboarding-acknowledge">
              <label htmlFor={`${baseId}-ack`} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12 }}>
                <input id={`${baseId}-ack`} type="checkbox" checked={decision.acknowledged} disabled={busy || locked} onChange={(event) => onboarding.setAcknowledged(event.target.checked)} style={{ marginTop: 2 }} />
                <span>{summary.kind === "unknown" ? `I understand the check could not be completed, and I want to create a new ${noun} anyway.` : `I have looked at the records above and I want to create a new ${noun} anyway.`}</span>
              </label>
              <div className="field">
                <label htmlFor={`${baseId}-reason`}>
                  Reason for creating a new {noun} <span style={{ color: "var(--orange)" }}>*</span>
                </label>
                <textarea id={`${baseId}-reason`} rows={3} value={decision.reason} maxLength={DUPLICATE_REASON_MAX} disabled={busy || locked} aria-required="true" aria-describedby={`${baseId}-reason-hint`} onChange={(event) => onboarding.setReason(event.target.value)} style={{ width: "100%", minHeight: 70 }} />
                <small id={`${baseId}-reason-hint`} className="muted">
                  Recorded in the Agreement activity. At least {DUPLICATE_REASON_MIN} characters.
                </small>
              </div>
            </div>
          )}

          {gates.decisionMessage && decision.kind !== "NONE" && (
            <p role="status" className="muted" style={{ margin: "10px 0 0", fontSize: 11 }} data-testid="onboarding-decision-message">
              {gates.decisionMessage}
            </p>
          )}

          <div className="actions" style={{ marginTop: 12 }}>
            <button type="button" className="btn ghost" onClick={recheck} disabled={busy || locked} style={busy || locked ? DISABLED_BUTTON_STYLE : undefined}>
              Check again
            </button>
          </div>
        </div>
      )}
    </WizardBlock>
  );
}
