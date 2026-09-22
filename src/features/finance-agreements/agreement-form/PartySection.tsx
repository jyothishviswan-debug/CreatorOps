"use client";

// Step 14C.3, IA section 1 "Agreement party": Partner or Vendor, existing or new-from-Agreement, and for a Partner the
// platform(s) and account scope. Built on native radio inputs inside `.fields`/`.field` (a native radiogroup already
// gets keyboard navigation for free) - the same pure agreement-for.ts / agreement-for-ui.ts rules as before.
import Link from "next/link";
import { useCallback, useEffect, useId, useState, type MouseEvent } from "react";

import { searchCounterparties as searchCounterpartiesApi, getCounterpartyPreview } from "../api-client";
import { ACCOUNT_SCOPE_DESCRIPTIONS, ACCOUNT_SCOPE_LABELS, AGREEMENT_FOR_OPTIONS, groupAccountsByPlatform, resolveAgreementFor, type AccountScope, type AgreementForChoice } from "../agreement-for";
import { Combobox } from "../components/Combobox";
import type { ComboboxSearchResult } from "../components/combobox-logic";
import { counterpartyTypeLabel, DISABLED_BUTTON_STYLE, formatPlatformList, lifecycleDisplayChip, NO_VALUE_TEXT } from "../format";
import {
  accountLabel,
  choiceCounterpartyType,
  EMPTY_AGREEMENT_FOR,
  evaluateAgreementFor,
  searchResultToOption,
  selectAccount,
  selectChoice,
  selectCounterparty,
  selectScope,
  type AgreementForState,
} from "../agreement-intake-logic/agreement-for-ui";
import { INTAKE_BUSY, useIntake } from "../agreement-intake-logic/intake-context";
import { onboardingModeOptions, type OnboardingModeChoice } from "../agreement-intake-logic/onboarding/onboarding-mode";

import { SectionCard } from "./SectionCard";

export function PartySection() {
  const intake = useIntake();
  if (intake.hasDraft) return <LockedSummary />;
  if (!intake.flags.canManage) {
    return (
      <SectionCard sectionKey="party" title="Agreement party" description="Choose who the Agreement is with.">
        <p className="foundationnote">You can view Agreements, but starting a new one needs the Manage Agreements permission.</p>
      </SectionCard>
    );
  }
  return <ChoiceForm />;
}

function initialState(preview: ReturnType<typeof useIntake>["preview"], seededChoice: AgreementForChoice | null): AgreementForState {
  if (!preview && seededChoice) return { ...EMPTY_AGREEMENT_FOR, choice: seededChoice };
  if (!preview) return EMPTY_AGREEMENT_FOR;
  return { ...EMPTY_AGREEMENT_FOR, choice: preview.type === "VENDOR" ? "VENDOR" : null, counterparty: { id: preview.ref, label: preview.displayName }, preselectedType: preview.type };
}

function RadioCards<T extends string>({ name, value, items, disabled, onChange }: { name: string; value: T | null; items: { value: T; title: string; description: string }[]; disabled?: boolean; onChange: (value: T) => void }) {
  return (
    <div className="fields" role="radiogroup">
      {items.map((item) => (
        <label key={item.value} className="field" style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, cursor: disabled ? "not-allowed" : "pointer", background: value === item.value ? "var(--tint)" : "white" }}>
          <span style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input type="radio" name={name} checked={value === item.value} disabled={disabled} onChange={() => onChange(item.value)} style={{ marginTop: 3 }} />
            <span>
              <b style={{ display: "block", fontSize: 13 }}>{item.title}</b>
              <small className="muted">{item.description}</small>
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

function ChoiceForm() {
  const intake = useIntake();
  const { preview, setPreview, setPreviewLoad, startDraft, isBusy, onboarding, permissions } = intake;
  const [state, setState] = useState<AgreementForState>(() => initialState(preview, onboarding.selection.choice));
  const [showIssues, setShowIssues] = useState(false);
  const comboboxId = useId();
  const busy = isBusy(INTAKE_BUSY.startDraft);
  const anyBusy = isBusy();
  const choicesLocked = busy || onboarding.locked;

  const counterpartyType = choiceCounterpartyType(state.choice);
  const creatingNew = onboarding.selection.mode === "new";
  const isPartner = counterpartyType === "PARTNER";
  const noun = counterpartyType === "VENDOR" ? "Vendor" : "Partner";
  const accounts = preview && state.counterparty && preview.ref === state.counterparty.id ? preview.partnerAccounts : null;
  const evaluation = evaluateAgreementFor(state, accounts);
  const platforms = state.choice ? resolveAgreementFor(state.choice).platforms : [];
  const groups = groupAccountsByPlatform(platforms, accounts ?? []);

  const pickedRef = state.counterparty?.id ?? null;
  const previewMatches = preview !== null && preview.ref === pickedRef && preview.type === counterpartyType;
  useEffect(() => {
    if (!pickedRef || !counterpartyType) return;
    if (previewMatches) return;
    const controller = new AbortController();
    setPreviewLoad({ status: "loading" });
    void getCounterpartyPreview({ counterpartyType, ref: pickedRef }, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setPreview(result.data);
        setPreviewLoad({ status: "ready" });
      } else if (!result.aborted) {
        setPreview(null);
        setPreviewLoad({ status: "error", message: result.message });
      }
    });
    return () => controller.abort();
  }, [pickedRef, counterpartyType, previewMatches, setPreview, setPreviewLoad]);

  useEffect(() => {
    if (!pickedRef && preview) {
      setPreview(null);
      setPreviewLoad({ status: "idle" });
    }
  }, [pickedRef, preview, setPreview, setPreviewLoad]);

  const loadOptions = useCallback(
    async (query: string, signal: AbortSignal): Promise<ComboboxSearchResult> => {
      if (!counterpartyType) return { ok: true, options: [] };
      const result = await searchCounterpartiesApi({ counterpartyType, q: query, limit: 10 }, { signal });
      if (!result.ok) return { ok: false, message: result.message };
      return { ok: true, options: result.data.results.map(searchResultToOption), hasMore: result.data.hasMore };
    },
    [counterpartyType],
  );

  const onStart = async () => {
    if (busy || anyBusy) return;
    if (!evaluation.ok) {
      setShowIssues(true);
      return;
    }
    await startDraft({ counterparty: evaluation.counterparty, recordPlatformsField: evaluation.recordPlatformsField, displayName: state.counterparty?.label ?? null });
  };

  const issues = evaluation.ok ? [] : evaluation.issues;

  return (
    <SectionCard sectionKey="party" title="Agreement party" description="Choose who the Agreement is with. The choice is fixed once the draft is started.">
      <b style={{ fontSize: 13, display: "block", marginBottom: 8 }}>
        Partner or Vendor <span style={{ color: "var(--orange)" }}>*</span>
      </b>
      <RadioCards
        name="agreement-for"
        value={state.choice}
        disabled={choicesLocked}
        items={AGREEMENT_FOR_OPTIONS.map((option) => ({ value: option.value, title: option.label, description: option.description }))}
        onChange={(value) => {
          setState((current) => selectChoice(current, value));
          onboarding.setSelection({ choice: value });
        }}
      />

      {state.choice && counterpartyType && (
        <div style={{ marginTop: 16 }}>
          <b style={{ fontSize: 13, display: "block", marginBottom: 8 }}>Existing or new {noun}</b>
          <RadioCards
            name="onboarding-mode"
            value={onboarding.selection.mode}
            disabled={choicesLocked}
            items={onboardingModeOptions(counterpartyType, permissions).map((option) => ({ value: option.value, title: option.title, description: option.description }))}
            onChange={(value: OnboardingModeChoice) => onboarding.setSelection({ mode: value })}
          />
          {creatingNew && (
            <small className="muted" role="status" style={{ display: "block", marginTop: 6 }}>
              {isPartner ? `One ${noun} is created${platforms.length > 1 ? " with a separate account on each platform" : ""}, from the signed Agreement, after a check for an existing ${noun}.` : `The ${noun} is created from the signed Agreement, after a check for an existing ${noun}. No represented Partner is created or linked.`}
            </small>
          )}
        </div>
      )}

      {state.choice && !creatingNew && (
        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor={comboboxId}>
            {noun} <span style={{ color: "var(--orange)" }}>*</span>
          </label>
          <Combobox key={counterpartyType ?? "none"} id={comboboxId} label={`Search ${noun}`} noun={noun} value={state.counterparty} onChange={(option) => setState((current) => selectCounterparty(current, option))} loadOptions={loadOptions} placeholder={`Search authorized ${noun}s by name`} disabled={busy} />
          <small>Only {noun}s you are authorized for are listed.</small>
        </div>
      )}

      {isPartner && state.counterparty && !creatingNew && (
        <PartnerScope state={state} groups={groups} accountsLoaded={accounts !== null} disabled={busy} onScope={(scope) => setState((current) => selectScope(current, scope, accounts ?? []))} onAccount={(platform, ref) => setState((current) => selectAccount(current, platform, ref))} />
      )}

      {counterpartyType === "VENDOR" && state.counterparty && !creatingNew && (
        <p className="foundationnote" style={{ marginTop: 12 }}>
          This Agreement is with the Vendor itself. A Partner the Vendor may represent is not inferred and does not become a party to the Agreement.
        </p>
      )}

      {showIssues && !creatingNew && issues.length > 0 && (
        <div className="banner" role="alert" style={{ margin: "14px 0 0" }}>
          <span>
            <b>Before you start the draft</b>
            <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
              {issues.map((issue) => (
                <li key={`${issue.code}-${issue.platform ?? ""}`}>{issue.message}</li>
              ))}
            </ul>
          </span>
        </div>
      )}

      {!creatingNew && (
        <div className="actions" style={{ marginTop: 16, alignItems: "center" }}>
          <button type="button" className="btn primary" onClick={onStart} disabled={busy || anyBusy || !evaluation.ok} style={busy || anyBusy || !evaluation.ok ? DISABLED_BUTTON_STYLE : undefined}>
            {busy ? "Starting draft…" : "Start draft"}
          </button>
          {!evaluation.ok && issues[0] && (
            <small className="muted" role="status">
              {issues[0].message}
            </small>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function PartnerScope({
  state,
  groups,
  accountsLoaded,
  disabled,
  onScope,
  onAccount,
}: {
  state: AgreementForState;
  groups: ReturnType<typeof groupAccountsByPlatform>;
  accountsLoaded: boolean;
  disabled: boolean;
  onScope: (scope: AccountScope) => void;
  onAccount: (platform: string, partnerAccountRef: string) => void;
}) {
  if (!state.choice) return null;
  const platformNames = formatPlatformList(resolveAgreementFor(state.choice).platforms);
  return (
    <div style={{ marginTop: 16 }}>
      <b style={{ fontSize: 13, display: "block", marginBottom: 8 }}>
        Scope of the Agreement <span style={{ color: "var(--orange)" }}>*</span>
      </b>
      <RadioCards name="account-scope" value={state.scope} disabled={disabled || !accountsLoaded} items={(["ACCOUNT_SPECIFIC", "PARTNER_LEVEL"] as const).map((scope) => ({ value: scope, title: ACCOUNT_SCOPE_LABELS[scope], description: ACCOUNT_SCOPE_DESCRIPTIONS[scope] }))} onChange={onScope} />
      {!accountsLoaded && (
        <small className="muted" role="status">
          Loading this Partner&apos;s accounts…
        </small>
      )}

      {state.scope === "PARTNER_LEVEL" && (
        <p className="foundationnote" style={{ marginTop: 10 }}>
          Partner-level: no Partner Account is named. The intended platform{groups.length === 1 ? "" : "s"} ({platformNames}) will be recorded on the Agreement.
        </p>
      )}

      {state.scope === "ACCOUNT_SPECIFIC" &&
        groups.map((group) => (
          <div key={group.platform} style={{ marginTop: 14 }}>
            <b style={{ fontSize: 13, display: "block", marginBottom: 6 }}>
              {group.platformLabel} account <span style={{ color: "var(--orange)" }}>*</span>
            </b>
            {group.missing ? (
              <div className="banner" role="alert" style={{ margin: 0 }}>
                <span>
                  This Partner has no active {group.platformLabel} account{group.inactiveCount > 0 ? ` (${group.inactiveCount} inactive)` : ""}. Choose Partner-level, or add the account to the Partner first.
                </span>
              </div>
            ) : (
              <>
                {group.requiresChoice && (
                  <small className="muted" style={{ display: "block", marginBottom: 6 }}>
                    This Partner has {group.eligible.length} {group.platformLabel} accounts. Choose the one this Agreement covers.
                  </small>
                )}
                <RadioCards
                  name={`account-${group.platform}`}
                  value={state.selection[group.platform] ?? null}
                  disabled={disabled}
                  items={group.eligible.map((account) => {
                    const label = accountLabel(account);
                    return { value: account.partnerAccountRef, title: label.title, description: label.detail ?? "" };
                  })}
                  onChange={(value) => onAccount(group.platform, value)}
                />
              </>
            )}
          </div>
        ))}
    </div>
  );
}

function LockedSummary() {
  const intake = useIntake();
  const { counterparty, agreement, preview, hasUnsavedEdits } = intake;
  if (!counterparty || !agreement) return null;
  const head = agreement.head;
  const version = agreement.selectedVersion;
  const accounts = (preview?.partnerAccounts ?? []).filter((account) => counterparty.accountRefs.includes(account.partnerAccountRef));
  const recordedPlatforms = Array.isArray(version?.draft.platforms?.value) ? (version!.draft.platforms!.value as unknown[]).filter((item): item is string => typeof item === "string") : [];
  const platforms = counterparty.platforms.length > 0 ? counterparty.platforms : recordedPlatforms;
  const modeText = counterparty.mode === "account-specific" ? "Account-specific" : counterparty.mode === "partner-level" ? "Partner-level" : "Vendor Agreement";

  const onNewDraft = (event: MouseEvent<HTMLAnchorElement>) => {
    if (hasUnsavedEdits && !window.confirm("You have unsaved changes on this draft. Leave without saving?")) event.preventDefault();
  };

  return (
    <SectionCard sectionKey="party" title="Agreement party" description="The counterparty is fixed for this draft. To change it, start a new draft.">
      <div className="fields">
        <div className="field">
          <label>{counterpartyTypeLabel(counterparty.type)}</label>
          <p style={{ margin: 0, fontSize: 13 }}>{counterparty.displayName}</p>
        </div>
        <div className="field">
          <label>Agreement for</label>
          <p style={{ margin: 0, fontSize: 13 }}>{agreementForText(counterparty.type, platforms)}</p>
        </div>
        <div className="field">
          <label>Scope</label>
          <p style={{ margin: 0, fontSize: 13 }}>{modeText}</p>
        </div>
        {counterparty.type === "PARTNER" && (
          <div className="field">
            <label>{counterparty.mode === "account-specific" ? "Partner Accounts" : "Platforms recorded"}</label>
            <p style={{ margin: 0, fontSize: 13 }}>{counterparty.mode === "account-specific" ? (accounts.length > 0 ? accounts.map((account) => `${account.platform} · ${accountLabel(account).title}`).join(", ") : `${counterparty.accountRefs.length} selected`) : formatPlatformList(platforms) || NO_VALUE_TEXT}</p>
          </div>
        )}
        <div className="field">
          <label>Agreement ref</label>
          <p style={{ margin: 0, fontSize: 13 }}>{head.agreementRef}</p>
        </div>
        <div className="field">
          <label>Draft version</label>
          <p style={{ margin: 0, fontSize: 13 }}>
            {version ? `Version ${version.version}` : NO_VALUE_TEXT} · {lifecycleDisplayChip(head.status, version?.confirmed === true).label}
          </p>
        </div>
      </div>
      <div className="actions" style={{ marginTop: 12 }}>
        <Link className="btn ghost" href="/finance/agreements/new" onClick={onNewDraft}>
          Start a new draft
        </Link>
      </div>
    </SectionCard>
  );
}

function agreementForText(type: "PARTNER" | "VENDOR", platforms: readonly string[]): string {
  if (type === "VENDOR") return "Vendor";
  const has = (platform: string) => platforms.includes(platform);
  if (has("instagram") && has("youtube")) return "Instagram + YouTube Partner";
  if (has("instagram")) return "Instagram Partner";
  if (has("youtube")) return "YouTube Partner";
  return "Partner";
}
