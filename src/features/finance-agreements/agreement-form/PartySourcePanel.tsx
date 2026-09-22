"use client";

// FINAL_EXECUTION Panel 1 - Party & Source. Foundation archetype only: `.panel`/`.panelhead`/`.panelbody`, the
// `.grid`/`.sN` 12-column field grid, `.record` cards for the choice buttons - none of it borrowed from any
// rejected prior version of this presentation layer.
import { useState } from "react";

import { Button } from "@/ui/Button";
import { Pill } from "@/ui/Badge";

import * as api from "../api-client";
import { AGREEMENT_FOR_OPTIONS, groupAccountsByPlatform, type AccountScope } from "../agreement-for";
import {
  EMPTY_AGREEMENT_FOR,
  accountLabel,
  evaluateAgreementFor,
  searchResultToOption,
  selectAccount,
  selectChoice,
  selectCounterparty,
  selectScope,
  type AgreementForState,
} from "../agreement-intake-logic/agreement-for-ui";
import { useIntake } from "../agreement-intake-logic/intake-context";
import { Combobox } from "../components";
import { onboardingModeOptions, type OnboardingModeChoice } from "../agreement-intake-logic/onboarding/onboarding-mode";
import { artifactSummaryText, contractControls, pickContractFile } from "../agreement-intake-logic/contract-source-logic";
import { formatFileSize } from "../format";

import { NewCounterpartyWizard } from "./NewCounterpartyWizard";
import { SectionCard } from "./SectionCard";

export function PartySourcePanel() {
  const { permissions, hasDraft, counterparty, preview, previewLoad, setPreview, setPreviewLoad, startDraft, onboarding, isBusy, flags, agreement, version, artifact, extraction, extractFromFile, attachExtraction, extractionAttached } = useIntake();
  const [local, setLocal] = useState<AgreementForState>(EMPTY_AGREEMENT_FOR);

  if (!hasDraft) {
    const choiceType = local.choice ? AGREEMENT_FOR_OPTIONS.find((o) => o.value === local.choice)!.counterpartyType : null;
    const modeOptions = choiceType ? onboardingModeOptions(choiceType, permissions) : [];
    const mode: OnboardingModeChoice = onboarding.selection.mode;

    const chooseCard = (value: (typeof AGREEMENT_FOR_OPTIONS)[number]["value"]) => {
      setLocal((s) => selectChoice(s, value));
      onboarding.setSelection({ choice: value, mode: onboarding.selection.mode });
    };

    return (
      <SectionCard title="Party & Source" description="What is this Agreement for, and who is the counterparty?">
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
            <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>{modeOptions.find((o) => o.value === mode)?.description}</p>
          </div>
        )}

        {choiceType && mode === "existing" && (
          <ExistingCounterpartyPicker state={local} setState={setLocal} preview={preview} setPreview={setPreview} previewLoad={previewLoad} setPreviewLoad={setPreviewLoad} startDraft={startDraft} busy={isBusy()} />
        )}

        {choiceType && mode === "new" && <NewCounterpartyWizard onboarding={onboarding} />}
      </SectionCard>
    );
  }

  // A draft already exists: the party choice is locked (a different counterparty is a new draft). Show the
  // frozen party + the source document strip.
  const controls = contractControls({ canExtract: flags.canEdit, hasFile: artifact !== null, busy: isBusy(), extraction, attached: extractionAttached });

  return (
    <SectionCard title="Party & Source" description="The Agreement party and the original signed document.">
      <div className="grid">
        <div className="s6">
          <div className="kv">
            <span>Counterparty</span>
            <b>{counterparty?.displayName ?? agreement?.head.counterpartyDisplayName ?? "—"}</b>
          </div>
          <div className="kv">
            <span>Type</span>
            <b>{agreement?.head.counterparty.type === "PARTNER" ? "Partner" : "Vendor"}</b>
          </div>
          {agreement?.head.priorAgreementRef && (
            <div className="kv">
              <span>Renews</span>
              <b>{agreement.head.priorAgreementRef}</b>
            </div>
          )}
        </div>
        <div className="s6">
          <div className="record">
            <h3>Source Agreement</h3>
            {artifact ? (
              <p className="muted" style={{ marginTop: 6 }}>
                {artifactSummaryText(artifact, formatFileSize)}
              </p>
            ) : (
              <p className="muted" style={{ marginTop: 6 }}>
                No file uploaded yet.
              </p>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
              <label className="btn" style={{ display: "inline-flex" }}>
                {artifact ? "Replace" : "Upload"}
                <input
                  type="file"
                  accept="application/pdf"
                  style={{ display: "none" }}
                  disabled={!flags.canEdit || isBusy()}
                  onChange={(event) => {
                    const picked = pickContractFile(event.target.files?.[0] ?? null);
                    if (picked.file) void extractFromFile(picked.file);
                    event.target.value = "";
                  }}
                />
              </label>
              {controls.showAttach && (
                <Button variant="primary" disabled={!controls.canAttach || isBusy()} onClick={() => void attachExtraction()}>
                  Extract into fields
                </Button>
              )}
              {version?.document && <Pill tone={version.document.status === "STORED" ? "default" : "orange"}>{version.document.status === "STORED" ? "Stored" : (version.document.message ?? version.document.status)}</Pill>}
            </div>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

function ExistingCounterpartyPicker({
  state,
  setState,
  preview,
  setPreview,
  previewLoad,
  setPreviewLoad,
  startDraft,
  busy,
}: {
  state: AgreementForState;
  setState: (updater: (state: AgreementForState) => AgreementForState) => void;
  preview: ReturnType<typeof useIntake>["preview"];
  setPreview: ReturnType<typeof useIntake>["setPreview"];
  previewLoad: ReturnType<typeof useIntake>["previewLoad"];
  setPreviewLoad: ReturnType<typeof useIntake>["setPreviewLoad"];
  startDraft: ReturnType<typeof useIntake>["startDraft"];
  busy: boolean;
}) {
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
        <Button
          variant="primary"
          disabled={!evaluated.ok || busy || previewLoad.status === "loading"}
          onClick={() => {
            if (!evaluated.ok) return;
            void startDraft({ counterparty: evaluated.counterparty, recordPlatformsField: evaluated.recordPlatformsField, displayName: state.counterparty?.label });
          }}
        >
          Start draft
        </Button>
      </div>
    </div>
  );
}
