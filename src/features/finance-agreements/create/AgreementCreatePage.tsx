"use client";

// EXECUTE_HARD_RESET Section 4/6: the canonical page shell. Current CreatorOps AppShell (one global sidebar,
// current topbar, current Finance horizontal nav) - this component supplies only what's INSIDE the page: the
// header, the five-step progress strip, and (once a draft exists) the two-pane Step-1 extraction workspace or
// steps 2-5. Before a draft exists, choosing the Agreement party is what Step 1 starts with - the backend
// requires a counterparty to create the Agreement record at all, so extraction cannot precede it; nothing here
// alters that backend contract to fit a different page order.
import { useState } from "react";

import * as api from "../api-client";
import { AGREEMENT_FOR_OPTIONS, groupAccountsByPlatform, type AccountScope } from "../agreement-for";
import { EMPTY_AGREEMENT_FOR, accountLabel, evaluateAgreementFor, searchResultToOption, selectAccount, selectChoice, selectCounterparty, selectScope, type AgreementForState } from "../agreement-intake-logic/agreement-for-ui";
import { useIntake } from "../agreement-intake-logic/intake-context";
import { onboardingModeOptions, type OnboardingModeChoice } from "../agreement-intake-logic/onboarding/onboarding-mode";
import { accountFieldKey } from "../agreement-intake-logic/onboarding/wizard-form";
import { candidateCards } from "../agreement-intake-logic/onboarding/duplicate-rules";
import { Combobox } from "../components";
import { contractControls } from "../agreement-intake-logic/contract-source-logic";

import { documentView, extractionUiState, extractionWarningsOf, keyClauseViews, partyViews, extractedFieldView } from "./agreement-create-adapter";
import type { AgreementCreateStep } from "./agreement-create-view";
import { AgreementProgress } from "./AgreementProgress";
import { ConfirmStep } from "./ConfirmStep";
import { ExtractionReviewPane } from "./ExtractionReviewPane";
import { PartiesKycStep } from "./PartiesKycStep";
import { SourceDocumentPane, useLocalPreviewUrl } from "./SourceDocumentPane";
import { TermsTargetsStep } from "./TermsTargetsStep";
import { VerificationStep } from "./VerificationStep";
import styles from "./AgreementCreatePage.module.css";

export function AgreementCreatePage() {
  const { flags, hasDraft, notices, conflict, reloadLatest } = useIntake();
  const [step, setStep] = useState<AgreementCreateStep>(1);

  if (!flags.canManage) {
    return (
      <section className="panel">
        <div className="panelbody">
          <p>You need the Manage Agreements permission to start or edit an Agreement.</p>
        </div>
      </section>
    );
  }

  return (
    <div className={styles.page}>
      {conflict && (
        <div className="scopebox" style={{ marginBottom: 18 }}>
          <b>{conflict.message}</b>{" "}
          <button type="button" className="btn" onClick={() => void reloadLatest()}>
            Reload latest
          </button>
        </div>
      )}

      {!hasDraft ? (
        <PartySourceChoice />
      ) : (
        <>
          <AgreementProgress step={step} onStepClick={setStep} canJumpTo={() => true} />
          {step === 1 && <UploadExtractStep onContinue={() => setStep(2)} />}
          {step === 2 && <VerificationStep />}
          {step === 3 && <PartiesKycStep />}
          {step === 4 && <TermsTargetsStep />}
          {step === 5 && <ConfirmStep onGoToStep={setStep} />}
          {step > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 18 }}>
              <button type="button" className="btn" onClick={() => setStep((step - 1) as AgreementCreateStep)}>
                Back
              </button>
              {step < 5 && (
                <button type="button" className="btn primary" onClick={() => setStep((step + 1) as AgreementCreateStep)}>
                  Continue
                </button>
              )}
            </div>
          )}
        </>
      )}

      <div aria-live="polite" className="sr">
        {notices.length > 0 ? notices[notices.length - 1]!.message : ""}
      </div>
    </div>
  );
}

// --- Party / Source choice (before a draft exists) ---------------------------------------------------------------------------------------
function PartySourceChoice() {
  const { permissions, onboarding, startDraft } = useIntake();
  const [local, setLocal] = useState<AgreementForState>(EMPTY_AGREEMENT_FOR);

  const choiceType = local.choice ? AGREEMENT_FOR_OPTIONS.find((o) => o.value === local.choice)!.counterpartyType : null;
  const modeOptions = choiceType ? onboardingModeOptions(choiceType, permissions) : [];
  const mode: OnboardingModeChoice = onboarding.selection.mode;

  const chooseCard = (value: (typeof AGREEMENT_FOR_OPTIONS)[number]["value"]) => {
    setLocal((s) => selectChoice(s, value));
    onboarding.setSelection({ choice: value, mode: onboarding.selection.mode });
  };

  return (
    <section className="panel">
      <div className="panelhead">
        <h2>Party &amp; Source</h2>
        <p>What is this Agreement for, and who is the counterparty?</p>
      </div>
      <div className="panelbody">
        <div className="grid">
          {AGREEMENT_FOR_OPTIONS.map((option) => (
            <div key={option.value} className="s3">
              <button
                type="button"
                role="radio"
                aria-checked={local.choice === option.value}
                className="record"
                style={{ width: "100%", textAlign: "left", cursor: "pointer", borderColor: local.choice === option.value ? "var(--orange)" : undefined, background: local.choice === option.value ? "var(--tint)" : undefined }}
                onClick={() => chooseCard(option.value)}
              >
                <h3>{option.label}</h3>
                <p className="muted" style={{ marginTop: 4 }}>
                  {option.description}
                </p>
              </button>
            </div>
          ))}
        </div>

        {choiceType && (
          <div style={{ marginTop: 18 }}>
            <div className="segment" role="radiogroup" aria-label="How is the counterparty identified?">
              {modeOptions.map((option) => (
                <button key={option.value} type="button" className={mode === option.value ? "active" : ""} onClick={() => onboarding.setSelection({ mode: option.value })}>
                  {option.title}
                </button>
              ))}
            </div>
            <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              {modeOptions.find((o) => o.value === mode)?.description}
            </p>
          </div>
        )}

        {choiceType && mode === "existing" && <ExistingCounterpartyPicker state={local} setState={setLocal} startDraft={startDraft} />}
        {choiceType && mode === "new" && <NewCounterpartyWizard />}
      </div>
    </section>
  );
}

function ExistingCounterpartyPicker({ state, setState, startDraft }: { state: AgreementForState; setState: (updater: (state: AgreementForState) => AgreementForState) => void; startDraft: ReturnType<typeof useIntake>["startDraft"] }) {
  const { preview, previewLoad, setPreview, setPreviewLoad } = useIntake();
  const choiceType = state.choice ? AGREEMENT_FOR_OPTIONS.find((o) => o.value === state.choice)!.counterpartyType : null;
  if (!choiceType) return null;
  const accounts = preview?.partnerAccounts ?? [];
  const evaluated = evaluateAgreementFor(state, preview ? accounts : null);

  return (
    <div style={{ marginTop: 18 }}>
      <div className="field">
        <label>{choiceType === "PARTNER" ? "Partner" : "Vendor"}</label>
        <Combobox
          label={choiceType === "PARTNER" ? "Partner" : "Vendor"}
          noun={choiceType === "PARTNER" ? "Partner" : "Vendor"}
          value={state.counterparty}
          onChange={async (option) => {
            setState((s) => selectCounterparty(s, option));
            if (!option) {
              setPreview(null);
              return;
            }
            setPreviewLoad({ status: "loading" });
            const result = await api.getCounterpartyPreview({ counterpartyType: choiceType, ref: option.id });
            if (result.ok) {
              setPreview(result.data);
              setPreviewLoad({ status: "ready" });
            } else setPreviewLoad(result.aborted ? { status: "error" } : { status: "error", message: result.message });
          }}
          loadOptions={async (q, signal) => {
            const result = await api.searchCounterparties({ counterpartyType: choiceType, q }, { signal });
            return result.ok ? { ok: true, options: result.data.results.map(searchResultToOption), hasMore: result.data.hasMore } : { ok: false, message: result.aborted ? undefined : result.message };
          }}
        />
      </div>

      {choiceType === "PARTNER" && state.counterparty && (
        <div className="segment" role="radiogroup" aria-label="Account scope" style={{ marginTop: 14 }}>
          {(["ACCOUNT_SPECIFIC", "PARTNER_LEVEL"] as AccountScope[]).map((scope) => (
            <button key={scope} type="button" className={state.scope === scope ? "active" : ""} onClick={() => setState((s) => selectScope(s, scope, accounts))}>
              {scope === "ACCOUNT_SPECIFIC" ? "Account-specific" : "Partner-level"}
            </button>
          ))}
        </div>
      )}

      {choiceType === "PARTNER" && state.scope === "ACCOUNT_SPECIFIC" && state.choice && preview?.type === "PARTNER" && (
        <div className="grid" style={{ marginTop: 14 }}>
          {groupAccountsByPlatform(AGREEMENT_FOR_OPTIONS.find((o) => o.value === state.choice)!.platforms, accounts).map((group) => (
            <div key={group.platform} className="s6 field">
              <label>{group.platformLabel} account</label>
              {group.missing ? (
                <p className="muted">No active {group.platformLabel} account on this Partner.</p>
              ) : (
                <select value={state.selection[group.platform] ?? ""} onChange={(event) => setState((s) => selectAccount(s, group.platform, event.target.value))}>
                  <option value="" disabled>
                    Choose an account
                  </option>
                  {group.eligible.map((account) => {
                    const { title, detail } = accountLabel(account);
                    return (
                      <option key={account.partnerAccountRef} value={account.partnerAccountRef}>
                        {title}
                        {detail ? ` · ${detail}` : ""}
                      </option>
                    );
                  })}
                </select>
              )}
            </div>
          ))}
        </div>
      )}

      {!evaluated.ok && state.counterparty && (
        <p className="muted" style={{ marginTop: 10, color: "var(--red)" }}>
          {evaluated.issues[0]!.message}
        </p>
      )}

      <div style={{ marginTop: 16 }}>
        <Button disabled={!evaluated.ok || previewLoad.status === "loading"} onClick={evaluated.ok ? () => void startDraft({ counterparty: evaluated.counterparty, recordPlatformsField: evaluated.recordPlatformsField, displayName: state.counterparty?.label }) : undefined} />
      </div>
    </div>
  );
}

function Button({ disabled, onClick }: { disabled: boolean; onClick?: () => void }) {
  return (
    <button type="button" className="btn primary" disabled={disabled} onClick={onClick}>
      Start draft
    </button>
  );
}

function NewCounterpartyWizard() {
  const { onboarding } = useIntake();
  const { state, gates, type, pickFile, extractPreview, edit, checkDuplicates, chooseExisting, continueNew, setAcknowledged, setReason, create, outcomeView, startAgain } = onboarding;

  if (outcomeView) {
    return (
      <div className="scopebox" style={{ marginTop: 16 }}>
        <b>{outcomeView.title}</b>
        <p style={{ marginTop: 6 }}>{outcomeView.message}</p>
        {outcomeView.canStartAgain && (
          <button type="button" className="btn ghost" style={{ marginTop: 12 }} onClick={startAgain}>
            Start again
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div className="field">
        <label>Signed Agreement (PDF)</label>
        <input type="file" accept="application/pdf" disabled={state.file !== null} onChange={(event) => pickFile(event.target.files?.[0] ?? null)} />
        {state.fileError && <small style={{ color: "var(--red)" }}>{state.fileError}</small>}
        {state.file && (
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
            <span className="muted">{state.file.name}</span>
            <button type="button" className="btn" disabled={!gates.canPreview} onClick={() => void extractPreview()}>
              Extract proposed record
            </button>
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
        <button type="button" className="btn primary" disabled={!gates.canCheck} onClick={() => void checkDuplicates()}>
          Check for duplicates
        </button>
      </div>

      {gates.duplicates && (
        <div style={{ marginTop: 16 }}>
          {gates.duplicates.status === "none" && <p className="muted">No matching {type === "PARTNER" ? "Partner" : "Vendor"} found - safe to create new.</p>}
          {gates.duplicates.strongMatchOutsideYourAccess && <p style={{ color: "var(--red)" }}>A strong match exists outside your access. Ask an admin before creating a new record.</p>}
          <div className="grid">
            {candidateCards(gates.duplicates).map((candidate) => (
              <div key={candidate.ref} className="s6">
                <button type="button" className="record" style={{ width: "100%", textAlign: "left", cursor: "pointer", opacity: candidate.inactive ? 0.6 : 1 }} onClick={() => chooseExisting(candidate.ref)}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <b>{candidate.displayName}</b>
                    <span className={`pill${candidate.strength === "STRONG" ? " orange" : " gray"}`}>{candidate.strengthLabel}</span>
                  </div>
                  <p className="muted" style={{ marginTop: 4 }}>
                    {candidate.regionsText}
                  </p>
                </button>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {state.decision.kind === "USE_EXISTING" ? (
              <span className="pill blue">Using existing record</span>
            ) : (
              <>
                <button type="button" className={`btn${state.decision.kind === "CREATE_NEW" ? " primary" : ""}`} onClick={continueNew}>
                  Continue creating new
                </button>
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
        <button type="button" className="btn primary" disabled={!gates.canCreate || state.create.status === "running"} onClick={() => void create()}>
          {state.decision.kind === "USE_EXISTING" ? "Use existing and start draft" : "Create and start draft"}
        </button>
        {gates.createBlockedReason && (
          <p className="muted" style={{ marginTop: 6 }}>
            {gates.createBlockedReason}
          </p>
        )}
      </div>
    </div>
  );
}

// --- Step 1 (once a draft exists): the two-pane extraction workspace --------------------------------------------------------------------
function UploadExtractStep({ onContinue }: { onContinue: () => void }) {
  const { artifact, version, extraction, extractionAttached, extractFromFile, attachExtraction, flags, isBusy, fieldModels, counterparty, version: v } = useIntake();
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const previewUrl = useLocalPreviewUrl(pickedFile);

  const controls = contractControls({ canExtract: flags.canEdit, hasFile: artifact !== null, busy: isBusy(), extraction, attached: extractionAttached });
  const currency = v?.terms?.commercial.currency ?? null;
  const document = documentView({ artifact, document: v?.document ?? null, pageCount: extraction?.run.pageCount ?? null, previewUrl });
  const extractionState = extractionUiState({ hasArtifact: artifact !== null, phase: isBusy("upload") ? "uploading" : isBusy("extract") ? "extracting" : "idle", attached: extractionAttached, runStatus: extraction?.run.status ?? null, errored: false });
  const fields = fieldModels.filter((m) => m.hasValue || m.extractedValue !== null && m.extractedValue !== undefined).map((m) => extractedFieldView(m, currency));
  const parties = partyViews(counterparty, version?.parties ?? []);
  const keyClauses = keyClauseViews(fieldModels, currency);
  const warnings = extraction ? extractionWarningsOf(extraction) : [];

  return (
    <>
      <div className={styles.extractGrid}>
        <SourceDocumentPane
          document={document}
          canReplace={flags.canEdit}
          busy={isBusy()}
          onPick={(file) => {
            setPickedFile(file);
            void extractFromFile(file);
          }}
        />
        <ExtractionReviewPane
          state={extractionState}
          fields={fields}
          keyClauses={keyClauses}
          primaryParty={parties[0] ?? null}
          platforms={counterparty?.platforms ?? []}
          warnings={warnings}
          onShowLog={() => {}}
          onEditField={() => {}}
        />
      </div>
      {controls.showAttach && (
        <div style={{ marginTop: 16 }}>
          <button type="button" className="btn primary" disabled={!controls.canAttach || isBusy()} onClick={() => void attachExtraction()}>
            Extract into fields
          </button>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
        <button type="button" className="btn primary" onClick={onContinue}>
          Continue
        </button>
      </div>
    </>
  );
}
