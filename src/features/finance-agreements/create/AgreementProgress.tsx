"use client";

// EXECUTE_HARD_RESET Section 5: the compact five-step progress strip, built on Foundation's own `.workflow`/
// `.step` archetype (foundation.css) - the SAME primitive already used elsewhere in the app, never a new
// vertical wizard rail. Desktop shows all five; mobile collapses to "Step N of 5" (Section 5's own rule).
import { AGREEMENT_CREATE_STEPS, type AgreementCreateStep } from "./agreement-create-view";
import styles from "./AgreementCreatePage.module.css";

export function AgreementProgress({ step, onStepClick, canJumpTo }: { step: AgreementCreateStep; onStepClick: (step: AgreementCreateStep) => void; canJumpTo: (step: AgreementCreateStep) => boolean }) {
  const current = AGREEMENT_CREATE_STEPS.find((s) => s.step === step)!;

  return (
    <>
      <div className={`workflow ${styles.workflowFull}`} role="tablist" aria-label="Agreement creation steps">
        {AGREEMENT_CREATE_STEPS.map((s) => {
          const done = s.step < step;
          const isCurrent = s.step === step;
          const enabled = canJumpTo(s.step);
          return (
            <button
              key={s.step}
              type="button"
              role="tab"
              aria-selected={isCurrent}
              aria-current={isCurrent ? "step" : undefined}
              className={`step${done ? " done" : ""}${isCurrent ? " current" : ""}`}
              disabled={!enabled}
              onClick={() => enabled && onStepClick(s.step)}
              style={{ textAlign: "left", cursor: enabled ? "pointer" : "default" }}
            >
              <i aria-hidden="true">{done ? "✓" : s.step}</i>
              <span>
                {s.title}
                <br />
                <small className="muted" style={{ fontSize: 9 }}>
                  {s.subtitle}
                </small>
              </span>
            </button>
          );
        })}
      </div>

      <div className={styles.mobileStep}>
        <div>
          <b>{current.title}</b>
          <div className="muted" style={{ fontSize: 11 }}>
            {current.subtitle}
          </div>
        </div>
        <span className="muted" style={{ fontSize: 11 }}>
          Step {step} of 5
        </span>
      </div>
    </>
  );
}
