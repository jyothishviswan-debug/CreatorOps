"use client";

// Step 14B intake: the orchestrator of the staged Agreement form. ONE page, ten sections in the exact order of the product doc, inside
// the accepted `.formlayout > form.panel > section.formsection` frame with the accepted `.formfoot` and the right-hand `aside` checklist.
// The frame owns only what is shared (status announcements, the conflict banner, Save Draft, progress); every section reads its own
// state from `useIntake()` and takes no props.
import { useEffect, useState } from "react";

import { Icon } from "@/ui/icons";

import { DISABLED_BUTTON_STYLE, EXTRACTION_NOTE } from "../format";
import { AgreementForSection } from "./AgreementForSection";
import { ContractSourceSection } from "./ContractSourceSection";
import { ExistingDetailsSection } from "./ExistingDetailsSection";
import { ExtractedSection } from "./ExtractedSection";
import { consumeDraftJustStarted, INTAKE_BUSY, useIntake } from "./intake-context";
import { computeIntakeProgress, intakeSectionAnchor, PROGRESS_STATE_LABELS, progressSummary, type ProgressState } from "./intake-progress";
import { OnboardingWizard } from "./onboarding/OnboardingWizard";

// ==== BEGIN sections 5-10 (owned by the other intake agent; they must exist at these paths as named exports with NO props) ====
// A typecheck error on one of these lines means that file has not been created yet - nothing else in this file is affected.
import { CrossVerificationSection } from "./CrossVerificationSection";
import { CommercialTermsSection } from "./CommercialTermsSection";
import { PerformanceTargetsSection } from "./PerformanceTargetsSection";
import { KycSection } from "./KycSection";
import { AdditionalDetailsSection } from "./AdditionalDetailsSection";
import { ReviewConfirmSection } from "./ReviewConfirmSection";
// ==== END sections 5-10 ====

// One line of the right-hand checklist (the ten standard sections, or the new-counterparty wizard's steps).
type ChecklistItem = { key: string; number: number; title: string; state: ProgressState; anchorId: string; stateLabel: string };

export function IntakeForm() {
  const intake = useIntake();
  // True only for the form that mounted right after `Start draft` (see consumeDraftJustStarted): announce it and move focus on.
  const [justStarted] = useState(consumeDraftJustStarted);
  const { notify } = intake;
  useEffect(() => {
    if (!justStarted) return;
    notify("success", "Draft created. The counterparty is now fixed. Continue with Contract source.", "draft-created");
    document.getElementById(`${intakeSectionAnchor("contract_source")}-title`)?.focus();
  }, [justStarted, notify]);
  const { hasDraft, flags, isBusy, saveDraft, unsavedCount, hasUnsavedEdits, notices, dismissNotice, conflict, reloadLatest, scrollToAnchor } = intake;
  const saving = isBusy(INTAKE_BUSY.save);
  const anyBusy = isBusy();

  const { onboarding, onboardingHandoff } = intake;
  // A NEW Partner / Vendor being set up from the Agreement (no draft yet): the wizard replaces sections 2-5 and the checklist follows its steps.
  const onboardingActive = !hasDraft && onboarding.active;
  const standardProgress = computeIntakeProgress({ agreement: intake.agreement, preview: intake.preview, extraction: intake.extraction, extractionAttached: intake.extractionAttached, kyc: intake.kyc, fields: intake.fields });
  const progress: ChecklistItem[] = onboardingActive
    ? onboarding.progress.map((item) => ({ key: item.key, number: item.number, title: item.title, state: item.state, anchorId: item.anchorId, stateLabel: item.stateLabel }))
    : standardProgress.map((item) => ({ key: item.key, number: item.number, title: item.title, state: item.state, anchorId: item.anchorId, stateLabel: PROGRESS_STATE_LABELS[item.state] }));
  const summary = progressSummary(progress);

  const errors = notices.filter((notice) => notice.tone === "error");
  const status = notices.filter((notice) => notice.tone !== "error");
  const saveDisabled = saving || anyBusy;

  const footText = onboardingActive ? "Nothing is created until you confirm the last step." : !hasDraft ? "Start a draft to save your work." : hasUnsavedEdits ? `${unsavedCount} unsaved ${unsavedCount === 1 ? "change" : "changes"}` : "All changes saved";

  return (
    <div className="formlayout" data-testid="agreement-intake">
      {/* Enter inside a field (or a dialog rendered within this tree) must never submit anything: saving is the explicit Save Draft button. */}
      <form className="panel" onSubmit={(event) => event.preventDefault()} noValidate aria-label="New Agreement">
        <div style={{ padding: "0 22px" }}>
          {/* Polite status messages (saved, attached, ...) and assertive errors live above the sections, in stable regions. */}
          <div role="status" aria-live="polite" data-testid="intake-status">
            {status.map((notice) => (
              <div key={notice.id} className="banner" style={{ margin: "14px 0 0" }}>
                <span style={{ flex: 1 }}>{notice.message}</span>
                <button type="button" className="btn ghost" onClick={() => dismissNotice(notice.id)} aria-label="Dismiss message">
                  Dismiss
                </button>
              </div>
            ))}
          </div>
          <div role="alert" data-testid="intake-errors">
            {errors.map((notice) => (
              <div key={notice.id} className="banner" style={{ margin: "14px 0 0", borderColor: "#e8c2c6", background: "#fdf6f6", color: "#8f3a42" }}>
                <span style={{ flex: 1 }}>
                  <b>Couldn’t complete that.</b> {notice.message}
                </span>
                <button type="button" className="btn ghost" onClick={() => dismissNotice(notice.id)} aria-label="Dismiss error">
                  Dismiss
                </button>
              </div>
            ))}
            {conflict && (
              <div className="banner" style={{ margin: "14px 0 0", borderColor: "#e8c2c6", background: "#fdf6f6", color: "#8f3a42" }}>
                <span style={{ flex: 1 }}>
                  <b>This Agreement changed elsewhere.</b> {conflict.message}
                </span>
                <button type="button" className="btn" onClick={() => void reloadLatest()} disabled={anyBusy} style={anyBusy ? DISABLED_BUTTON_STYLE : undefined}>
                  Reload latest
                </button>
              </div>
            )}
          </div>
          {hasDraft && onboardingHandoff.status === "failed" && onboardingHandoff.canRetry && (
            <div className="banner" style={{ margin: "14px 0 0" }} data-testid="onboarding-handoff-retry">
              <span style={{ flex: 1 }}>The signed Agreement is not on the draft yet.</span>
              <button type="button" className="btn" onClick={onboardingHandoff.retry} disabled={anyBusy} style={anyBusy ? DISABLED_BUTTON_STYLE : undefined}>
                Add the Agreement again
              </button>
            </div>
          )}
          {hasDraft && flags.readOnlyReason && (
            <div className="banner" role="status" style={{ margin: "14px 0 0" }}>
              <span>{flags.readOnlyReason}</span>
            </div>
          )}
        </div>

        <AgreementForSection />

        {onboardingActive && <OnboardingWizard />}
        {!hasDraft && !onboardingActive && <ExistingDetailsSection />}
        {hasDraft && (
          <>
            <ContractSourceSection />
            <ExistingDetailsSection />
            <ExtractedSection />
            <CrossVerificationSection />
            <CommercialTermsSection />
            <PerformanceTargetsSection />
            <KycSection />
            <AdditionalDetailsSection />
            <ReviewConfirmSection />
          </>
        )}
        {!hasDraft && (
          <section className="formsection" aria-label="Next sections">
            <p className="foundationnote" style={{ margin: 0 }}>
              {onboardingActive ? "The Agreement draft starts when the new record is created. Cross-verification, Commercial terms, Performance targets, KYC and Review follow on that draft." : "Contract source, Cross-verification, Commercial terms, Performance targets, KYC and Review open once the draft is started."}
            </p>
          </section>
        )}

        <div className="formfoot">
          <small role="status" aria-live="polite" data-testid="save-state">
            {footText}
          </small>
          <div className="actions">
            {hasDraft && flags.canEdit && (
              <button type="button" className="btn" onClick={() => void saveDraft()} disabled={saveDisabled} aria-disabled={saveDisabled} style={saveDisabled ? DISABLED_BUTTON_STYLE : undefined} data-testid="save-draft">
                {saving ? "Saving…" : "Save Draft"}
              </button>
            )}
          </div>
        </div>
      </form>

      <aside className="panel" style={{ alignSelf: "start" }} aria-label="Agreement progress">
        <div className="panelhead">
          <h2>Agreement progress</h2>
        </div>
        <div className="panelbody">
          <p className="foundationnote" style={{ marginBottom: 10 }} data-testid="progress-summary">
            {summary.done} of {summary.total} steps done
          </p>
          <ul className="checklist">
            {progress.map((item) => {
              const jumpable = item.state !== "locked";
              const content = (
                <>
                  <span style={{ display: "block", overflowWrap: "anywhere" }}>
                    {item.number}. {item.title}
                  </span>
                  <small style={{ display: "block", fontSize: 10 }}>{item.stateLabel}</small>
                </>
              );
              return (
                <li key={item.key} data-state={item.state}>
                  {item.state === "done" ? <Icon name="check" /> : <span aria-hidden="true" style={{ width: 15, height: 15, flexShrink: 0, borderRadius: "50%", border: "1.5px solid #c3cad2", marginTop: 2 }} />}
                  {jumpable ? (
                    <button type="button" onClick={() => scrollToAnchor(item.anchorId)} style={{ textAlign: "left", color: "inherit", fontSize: "inherit", padding: 0, minWidth: 0 }}>
                      {content}
                    </button>
                  ) : (
                    <div style={{ minWidth: 0 }}>{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="scopebox">{onboardingActive ? `${EXTRACTION_NOTE} Nothing is created until you confirm the last step.` : "Extraction suggests values only. Nothing is accepted, confirmed or written to Partner or Vendor records until you decide it."}</div>
        </div>
      </aside>
    </div>
  );
}
