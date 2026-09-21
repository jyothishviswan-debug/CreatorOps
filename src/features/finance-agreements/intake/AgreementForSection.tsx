"use client";

// Step 14B intake, section 1 `Agreement for`.
//   Before a draft: the four choices -> a searchable, authorized Partner / Vendor -> (Partner) the Partner Accounts and the explicit
//   Account-specific vs Partner-level choice -> `Start draft`. Nothing is inferred: an account is never chosen by display name, several
//   accounts on one platform need a deliberate pick, and a Vendor never implies a represented Partner.
//   Step 14B.1: after the Partner / Vendor card an explicit MODE choice - `Select existing Partner` (the flow above, the DEFAULT, unchanged) or
//   `Create new Partner from Agreement` (the onboarding wizard replaces the counterparty search: the record is created from the signed
//   Agreement, after a duplicate check). The Partner platform choice still means ONE Partner with an account per platform.
//   After a draft: a read-only summary (the counterparty cannot change) and a `Start a new draft` link.
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import { Icon } from "@/ui/icons";

import { searchCounterparties as searchCounterpartiesApi, getCounterpartyPreview } from "../api-client";
import { ACCOUNT_SCOPE_DESCRIPTIONS, ACCOUNT_SCOPE_LABELS, AGREEMENT_FOR_OPTIONS, groupAccountsByPlatform, resolveAgreementFor, type AccountScope, type AgreementForChoice } from "../agreement-for";
import { Combobox } from "../components/Combobox";
import type { ComboboxSearchResult } from "../components/combobox-logic";
import { KeyValueRow } from "../components/KeyValueRow";
import { StatusChip } from "../components/StatusChip";
import { counterpartyTypeLabel, DISABLED_BUTTON_STYLE, formatPlatformList, lifecycleDisplayChip, NO_VALUE_TEXT } from "../format";
import {
  accountLabel,
  choiceCounterpartyType,
  EMPTY_AGREEMENT_FOR,
  evaluateAgreementFor,
  radioKeyTarget,
  searchResultToOption,
  selectAccount,
  selectChoice,
  selectCounterparty,
  selectScope,
  type AgreementForState,
} from "./agreement-for-ui";
import { INTAKE_BUSY, useIntake } from "./intake-context";
import { intakeHref } from "./intake-logic";
import { onboardingModeOptions, type OnboardingModeChoice } from "./onboarding/onboarding-mode";
import { SectionCard } from "./SectionCard";

// `.attention` is the accepted row-style button; the inline box turns it into a compact selectable card (its first/last-child paddings are overridden).
const CARD_STYLE = { textAlign: "left", padding: "12px 14px", borderWidth: 1, borderStyle: "solid", borderColor: "var(--line)", borderRadius: 9, background: "#fff", minWidth: 0 } as const;
const CARD_GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 } as const;

export function AgreementForSection() {
  const intake = useIntake();
  if (intake.hasDraft) return <LockedSummary />;
  if (!intake.flags.canManage) {
    return (
      <SectionCard sectionKey="agreement_for" description="Choose who the Agreement is with.">
        <p className="foundationnote">You can view Agreements, but starting a new one needs the Manage Agreements permission.</p>
      </SectionCard>
    );
  }
  return <ChoiceForm />;
}

// --- Before a draft ----------------------------------------------------------------------------------------------------------------------------------------
function initialState(preview: ReturnType<typeof useIntake>["preview"], seededChoice: AgreementForChoice | null): AgreementForState {
  // A create-new deep link (?counterpartyType=VENDOR&mode=new) seeds the card (a Partner still needs its platform choice).
  if (!preview && seededChoice) return { ...EMPTY_AGREEMENT_FOR, choice: seededChoice };
  // A deep link from a Partner / Vendor page preselects the counterparty. A Vendor implies the Vendor card; a Partner still needs the platform choice.
  if (!preview) return EMPTY_AGREEMENT_FOR;
  return { ...EMPTY_AGREEMENT_FOR, choice: preview.type === "VENDOR" ? "VENDOR" : null, counterparty: { id: preview.ref, label: preview.displayName }, preselectedType: preview.type };
}

function ChoiceForm() {
  const intake = useIntake();
  const { preview, setPreview, setPreviewLoad, startDraft, isBusy, onboarding, permissions } = intake;
  const [state, setState] = useState<AgreementForState>(() => initialState(preview, onboarding.selection.choice));
  const [showIssues, setShowIssues] = useState(false);
  const scopeGroupId = useId();
  const comboboxId = useId();
  const modeGroupId = useId();
  const busy = isBusy(INTAKE_BUSY.startDraft);
  const anyBusy = isBusy();
  // Once a create request was sent for a new counterparty the choices are fixed (the request must not drift).
  const choicesLocked = busy || onboarding.locked;

  const counterpartyType = choiceCounterpartyType(state.choice);
  const creatingNew = onboarding.selection.mode === "new";
  const isPartner = counterpartyType === "PARTNER";
  const noun = counterpartyType === "VENDOR" ? "Vendor" : "Partner";
  const platformCount = state.choice ? resolveAgreementFor(state.choice).platforms.length : 0;
  const accounts = preview && state.counterparty && preview.ref === state.counterparty.id ? preview.partnerAccounts : null;
  const evaluation = evaluateAgreementFor(state, accounts);
  const platforms = state.choice ? resolveAgreementFor(state.choice).platforms : [];
  const groups = groupAccountsByPlatform(platforms, accounts ?? []);

  // Load the master data of the picked counterparty (aborts when the pick changes).
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
        // A Partner with exactly one account per platform is suggested (still visible and changeable) once the scope is Account-specific.
      } else if (!result.aborted) {
        setPreview(null);
        setPreviewLoad({ status: "error", message: result.message });
      }
    });
    return () => controller.abort();
  }, [pickedRef, counterpartyType, previewMatches, setPreview, setPreviewLoad]);

  // The picked counterparty went away (or the card type changed): drop the previous one's master data.
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
    <SectionCard sectionKey="agreement_for" description="Choose who the Agreement is with. The choice is fixed once the draft is started.">
      <div className="fields">
        <div className="field full">
          <span id={`${scopeGroupId}-choice`} style={{ fontSize: 11, fontWeight: 550 }}>
            Agreement for <span style={{ color: "var(--orange)" }}>*</span>
          </span>
          <CardRadioGroup
            labelledBy={`${scopeGroupId}-choice`}
            value={state.choice}
            disabled={choicesLocked}
            items={AGREEMENT_FOR_OPTIONS.map((option) => ({ value: option.value, title: option.label, description: option.description }))}
            onChange={(value) => {
              setState((current) => selectChoice(current, value as AgreementForChoice));
              onboarding.setSelection({ choice: value as AgreementForChoice });
            }}
          />
        </div>

        {state.choice && counterpartyType && (
          <div className="field full">
            <span id={`${modeGroupId}-mode`} style={{ fontSize: 11, fontWeight: 550 }}>
              Existing or new {noun}
            </span>
            <CardRadioGroup
              labelledBy={`${modeGroupId}-mode`}
              value={onboarding.selection.mode}
              disabled={choicesLocked}
              items={onboardingModeOptions(counterpartyType, permissions).map((option) => ({ value: option.value, title: option.title, description: option.description }))}
              onChange={(value) => onboarding.setSelection({ mode: value as OnboardingModeChoice })}
            />
            {creatingNew && (
              <small className="muted" role="status">
                {isPartner ? `One ${noun} is created${platformCount > 1 ? " with a separate account on each platform" : ""}, from the signed Agreement, after a check for an existing ${noun}.` : `The ${noun} is created from the signed Agreement, after a check for an existing ${noun}. No represented Partner is created or linked.`}
              </small>
            )}
          </div>
        )}

        {state.choice && !creatingNew && (
          <div className="field full">
            <label htmlFor={comboboxId}>
              {noun} <span style={{ color: "var(--orange)" }}>*</span>
            </label>
            <Combobox
              key={counterpartyType ?? "none"}
              id={comboboxId}
              label={`Search ${noun}`}
              noun={noun}
              value={state.counterparty}
              onChange={(option) => setState((current) => selectCounterparty(current, option))}
              loadOptions={loadOptions}
              placeholder={`Search authorized ${noun}s by name`}
              disabled={busy}
              aria-describedby={`${comboboxId}-hint`}
            />
            <small id={`${comboboxId}-hint`}>Only {noun}s you are authorized for are listed.</small>
          </div>
        )}

        {isPartner && state.counterparty && !creatingNew && (
          <PartnerScope
            state={state}
            groups={groups}
            accountsLoaded={accounts !== null}
            disabled={busy}
            onScope={(scope) => setState((current) => selectScope(current, scope, accounts ?? []))}
            onAccount={(platform, ref) => setState((current) => selectAccount(current, platform, ref))}
          />
        )}

        {counterpartyType === "VENDOR" && state.counterparty && !creatingNew && (
          <div className="field full">
            <p className="foundationnote" style={{ margin: 0 }}>
              This Agreement is with the Vendor itself. A Partner the Vendor may represent is not inferred and does not become a party to the Agreement.
            </p>
          </div>
        )}
      </div>

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
          <button type="button" className="btn primary" onClick={onStart} disabled={busy || anyBusy || !evaluation.ok} aria-disabled={busy || anyBusy || !evaluation.ok} style={busy || anyBusy || !evaluation.ok ? DISABLED_BUTTON_STYLE : undefined} data-testid="start-draft">
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

// --- Partner: Account-specific vs Partner-level ------------------------------------------------------------------------------------------------------
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
  const scopeLabelId = useId();
  if (!state.choice) return null;
  const platformNames = formatPlatformList(resolveAgreementFor(state.choice).platforms);
  return (
    <>
      <div className="field full">
        <span id={scopeLabelId} style={{ fontSize: 11, fontWeight: 550 }}>
          Scope of the Agreement <span style={{ color: "var(--orange)" }}>*</span>
        </span>
        <CardRadioGroup
          labelledBy={scopeLabelId}
          value={state.scope}
          disabled={disabled || !accountsLoaded}
          items={(["ACCOUNT_SPECIFIC", "PARTNER_LEVEL"] as const).map((scope) => ({ value: scope, title: ACCOUNT_SCOPE_LABELS[scope], description: ACCOUNT_SCOPE_DESCRIPTIONS[scope] }))}
          onChange={(value) => onScope(value as AccountScope)}
        />
        {!accountsLoaded && (
          <small className="muted" role="status">
            Loading this Partner&apos;s accounts…
          </small>
        )}
      </div>

      {state.scope === "PARTNER_LEVEL" && (
        <div className="field full">
          <p className="foundationnote" style={{ margin: 0 }}>
            Partner-level: no Partner Account is named. The intended platform{groups.length === 1 ? "" : "s"} ({platformNames}) will be recorded on the Agreement.
          </p>
        </div>
      )}

      {state.scope === "ACCOUNT_SPECIFIC" &&
        groups.map((group) => (
          <fieldset key={group.platform} className="field full" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <legend style={{ fontSize: 11, fontWeight: 550, padding: 0, marginBottom: 6 }}>
              {group.platformLabel} account <span style={{ color: "var(--orange)" }}>*</span>
            </legend>
            {group.missing ? (
              <div className="banner" role="alert" style={{ margin: 0 }}>
                <span>
                  This Partner has no active {group.platformLabel} account{group.inactiveCount > 0 ? ` (${group.inactiveCount} inactive)` : ""}. Choose Partner-level, or add the account to the Partner first.
                </span>
              </div>
            ) : (
              <>
                {group.requiresChoice && <small className="muted">This Partner has {group.eligible.length} {group.platformLabel} accounts. Choose the one this Agreement covers.</small>}
                <CardRadioGroup
                  labelledBy={undefined}
                  ariaLabel={`${group.platformLabel} account`}
                  value={state.selection[group.platform] ?? null}
                  disabled={disabled}
                  items={group.eligible.map((account) => {
                    const label = accountLabel(account);
                    return { value: account.partnerAccountRef, title: label.title, description: label.detail ?? undefined };
                  })}
                  onChange={(value) => onAccount(group.platform, value)}
                />
              </>
            )}
          </fieldset>
        ))}
    </>
  );
}

// --- Card radio group (accessible roving radios) ---------------------------------------------------------------------------------------------------
type CardItem = { value: string; title: string; description?: string };

function CardRadioGroup({ items, value, onChange, disabled = false, labelledBy, ariaLabel }: { items: CardItem[]; value: string | null; onChange: (value: string) => void; disabled?: boolean; labelledBy?: string; ariaLabel?: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(0, items.findIndex((item) => item.value === value));

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = radioKeyTarget(event.key, index, items.length);
    if (target === null) return;
    event.preventDefault();
    refs.current[target]?.focus();
    onChange(items[target]!.value);
  };

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : ariaLabel} style={CARD_GRID}>
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={index === activeIndex ? 0 : -1}
            disabled={disabled}
            className="attention"
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            style={{ ...CARD_STYLE, ...(selected ? { borderColor: "var(--orange)", boxShadow: "0 0 0 1px var(--orange)", background: "var(--tint)" } : {}), ...(disabled ? { cursor: "not-allowed", opacity: 0.7 } : {}) }}
          >
            <span className="grow" style={{ minWidth: 0 }}>
              <strong style={{ overflowWrap: "anywhere" }}>{item.title}</strong>
              {item.description && <small style={{ overflowWrap: "anywhere" }}>{item.description}</small>}
            </span>
            {selected && (
              <span className="pill" aria-hidden="false">
                <Icon name="check" style={{ width: 11, height: 11, marginRight: 3 }} />
                Selected
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// --- After a draft: read-only ------------------------------------------------------------------------------------------------------------------------------
function LockedSummary() {
  const intake = useIntake();
  const { counterparty, agreement, preview, hasUnsavedEdits } = intake;
  if (!counterparty || !agreement) return null;
  const head = agreement.head;
  const version = agreement.selectedVersion;
  const accounts = (preview?.partnerAccounts ?? []).filter((account) => counterparty.accountRefs.includes(account.partnerAccountRef));
  // A Partner-level draft records its platforms through the `platforms` field (the head's platform scope only follows named accounts).
  const recordedPlatforms = Array.isArray(version?.draft.platforms?.value) ? (version!.draft.platforms!.value as unknown[]).filter((item): item is string => typeof item === "string") : [];
  const platforms = counterparty.platforms.length > 0 ? counterparty.platforms : recordedPlatforms;
  const modeText = counterparty.mode === "account-specific" ? "Account-specific" : counterparty.mode === "partner-level" ? "Partner-level" : "Vendor Agreement";

  const onNewDraft = (event: MouseEvent<HTMLAnchorElement>) => {
    if (hasUnsavedEdits && !window.confirm("You have unsaved changes on this draft. Leave without saving?")) event.preventDefault();
  };

  return (
    <SectionCard sectionKey="agreement_for" description="The counterparty is fixed for this draft. To change it, start a new draft.">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", columnGap: 24 }}>
        <KeyValueRow label={counterpartyTypeLabel(counterparty.type)}>{counterparty.displayName}</KeyValueRow>
        <KeyValueRow label="Agreement for">{agreementForText(counterparty.type, platforms)}</KeyValueRow>
        <KeyValueRow label="Scope">{modeText}</KeyValueRow>
        {counterparty.type === "PARTNER" && (
          <KeyValueRow label={counterparty.mode === "account-specific" ? "Partner Accounts" : "Platforms recorded"}>
            {counterparty.mode === "account-specific" ? (accounts.length > 0 ? accounts.map((account) => `${account.platform} · ${accountLabel(account).title}`).join(", ") : `${counterparty.accountRefs.length} selected`) : formatPlatformList(platforms) || NO_VALUE_TEXT}
          </KeyValueRow>
        )}
        <KeyValueRow label="Agreement ref">{head.agreementRef}</KeyValueRow>
        <KeyValueRow label="Draft version">
          {version ? `Version ${version.version}` : NO_VALUE_TEXT} <StatusChip chip={lifecycleDisplayChip(head.status, version?.confirmed === true)} />
        </KeyValueRow>
      </div>
      <div className="actions" style={{ marginTop: 12 }}>
        <Link className="btn ghost" href={intakeHref()} onClick={onNewDraft}>
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
