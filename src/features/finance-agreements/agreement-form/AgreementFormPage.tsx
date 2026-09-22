"use client";

// Step 14C.3: the ONE canonical Agreement form, rebuilt from zero on the Foundation `formPage` archetype
// (docs/reference/CreatorOps_UI_Golden_Master.html / CreatorOps_Unified_Exact.tsx) - `.formlayout` = a
// `form.panel` (the seven sections) beside a right-hand `aside.panel` checklist, capped at the archetype's own
// 1080px. No table, no Confidence badge on a clean row, no "Contract text" on a clean row, no multi-button
// segment, and no separate "Extracted from Agreement" list. Every section here imports only pure logic / hooks
// from agreement-intake-logic/ - never JSX from the rejected v1/v2 presentation trees (both fully removed).
import { useEffect, useState } from "react";

import { Icon } from "@/ui/icons";

import { DISABLED_BUTTON_STYLE } from "../format";
import { agreementFormAnchorId, agreementFormProgressSummary, computeAgreementFormProgress, FORM_PROGRESS_STATE_LABELS } from "../agreement-intake-logic/agreement-form-progress";
import { consumeDraftJustStarted, INTAKE_BUSY, useIntake } from "../agreement-intake-logic/intake-context";

import { AgreementTermsSection } from "./AgreementTermsSection";
import { IdentityReviewSection } from "./IdentityReviewSection";
import { KycSection } from "./KycSection";
import { NewPartyOnboarding } from "./NewPartyOnboarding";
import { PartySection } from "./PartySection";
import { PerformanceTargetsSection } from "./PerformanceTargetsSection";
import { ReviewSection } from "./ReviewSection";
import { SourceAgreementSection } from "./SourceAgreementSection";

export function AgreementFormPage() {
  const intake = useIntake();
  const [justStarted] = useState(consumeDraftJustStarted);
  const { notify } = intake;
  useEffect(() => {
    if (!justStarted) return;
    notify("success", "Draft created. The counterparty is now fixed. Continue with the source Agreement.", "draft-created");
    document.getElementById(`${agreementFormAnchorId("source")}-title`)?.focus();
  }, [justStarted, notify]);

  const { hasDraft, flags, isBusy, saveDraft, unsavedCount, hasUnsavedEdits, notices, dismissNotice, conflict, reloadLatest, scrollToAnchor } = intake;
  const saving = isBusy(INTAKE_BUSY.save);
  const anyBusy = isBusy();
  const { onboarding, onboardingHandoff } = intake;
  const onboardingActive = !hasDraft && onboarding.active;

  const progress = computeAgreementFormProgress({ agreement: intake.agreement, preview: intake.preview, extraction: intake.extraction, kyc: intake.kyc, fields: intake.fields });
  const summary = agreementFormProgressSummary(progress);

  const errors = notices.filter((notice) => notice.tone === "error");
  const status = notices.filter((notice) => notice.tone !== "error");
  const saveDisabled = saving || anyBusy;
  const footText = onboardingActive ? "Nothing is created until you confirm the last step." : !hasDraft ? "Start a draft to save your work." : hasUnsavedEdits ? `${unsavedCount} unsaved ${unsavedCount === 1 ? "change" : "changes"}` : "All changes saved";

  return (
    <div className="formlayout" data-testid="agreement-form">
      <form className="panel" onSubmit={(event) => event.preventDefault()} noValidate aria-label="Agreement">
        <div style={{ padding: "0 22px" }}>
          <div role="status" aria-live="polite">
            {status.map((notice) => (
              <div key={notice.id} className="banner" style={{ margin: "14px 0 0" }}>
                <span style={{ flex: 1 }}>{notice.message}</span>
                <button type="button" className="btn ghost" onClick={() => dismissNotice(notice.id)} aria-label="Dismiss message">
                  Dismiss
                </button>
              </div>
            ))}
          </div>
          <div role="alert">
            {errors.map((notice) => (
              <div key={notice.id} className="banner" style={{ margin: "14px 0 0", borderColor: "#e8c2c6", background: "#fdf6f6", color: "#8f3a42" }}>
                <span style={{ flex: 1 }}>
                  <b>Couldn&rsquo;t complete that.</b> {notice.message}
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
            <div className="banner" style={{ margin: "14px 0 0" }}>
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

        <PartySection />

        {onboardingActive && <NewPartyOnboarding />}
        {!hasDraft && !onboardingActive && <IdentityReviewSection />}
        {hasDraft && (
          <>
            <SourceAgreementSection />
            <IdentityReviewSection />
            <KycSection />
            <AgreementTermsSection />
            <PerformanceTargetsSection />
            <ReviewSection />
          </>
        )}
        {!hasDraft && (
          <section className="formsection" aria-label="Next sections">
            <p className="foundationnote" style={{ margin: 0 }}>
              {onboardingActive ? "The Agreement draft starts when the new record is created. Source Agreement, KYC, Agreement terms and Review follow on that draft." : "Source Agreement, KYC, Agreement terms and Review open once the draft is started."}
            </p>
          </section>
        )}

        <div className="formfoot">
          <small role="status" aria-live="polite">
            {footText}
          </small>
          <div className="actions">
            {hasDraft && flags.canEdit && (
              <button type="button" className="btn" onClick={() => void saveDraft()} disabled={saveDisabled} style={saveDisabled ? DISABLED_BUTTON_STYLE : undefined}>
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
          <p className="foundationnote" style={{ marginBottom: 10 }}>
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
                  <small style={{ display: "block", fontSize: 10 }}>{FORM_PROGRESS_STATE_LABELS[item.state]}</small>
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
          <div className="scopebox">{onboardingActive ? "Extraction suggests values only. Nothing is created until you confirm the last step." : "Extraction suggests values only. Nothing is accepted, confirmed or written to Partner or Vendor records until you decide it."}</div>
        </div>
      </aside>
    </div>
  );
}
