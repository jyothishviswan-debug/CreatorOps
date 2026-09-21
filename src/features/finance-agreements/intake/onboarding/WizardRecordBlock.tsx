"use client";

// Onboarding wizard, step 2: the PROPOSED NEW MASTER RECORD - editable, prefilled from the extraction where the Agreement stated it. Raw `.field`
// markup with real label / input association (useId), inline validators (shared email / phone shape checks), one canonical region, the Vendor
// type for a Vendor, and one Partner Account row per selected platform (page link OR handle - one canonical locator each; page name optional).
// Nothing here is saved: `Check for existing ...` is the next step, and nothing is created until the last one.
import { useId, useState } from "react";

import { REGION_GROUPS } from "@/features/shared/canonical-regions";

import { formatPlatformName, DISABLED_BUTTON_STYLE } from "../../format";
import { INTAKE_BUSY, useIntake } from "../intake-context";
import { ONBOARDING_STEP_ANCHORS } from "./onboarding-progress";
import { requestDuplicatesResultFocus } from "./duplicates-focus";
import { accountFieldKey, issueFor, ONBOARDING_VENDOR_TYPES, prefillNotes, type FormFieldKey, type LocatorKind } from "./wizard-form";
import { WizardBlock } from "./WizardBlock";

const REQUIRED = <span style={{ color: "var(--orange)" }}>*</span>;

export function WizardRecordBlock() {
  const { onboarding, isBusy } = useIntake();
  const { state, gates, type } = onboarding;
  const noun = type === "PARTNER" ? "Partner" : "Vendor";
  const baseId = useId();
  const [blurred, setBlurred] = useState<ReadonlySet<string>>(new Set());
  const busy = isBusy();
  const locked = gates.locked;
  const previewReady = state.preview.status === "ready";
  const notes = state.preview.status === "ready" ? prefillNotes(state.preview.data, state.form) : [];
  const checking = isBusy(INTAKE_BUSY.onboardDuplicates);

  const visible = (field: FormFieldKey) => state.showIssues || blurred.has(field);
  const errorOf = (field: FormFieldKey): string | null => (visible(field) ? issueFor(gates.issues, field) : null);
  const touch = (field: FormFieldKey) => setBlurred((current) => (current.has(field) ? current : new Set(current).add(field)));

  const check = () => {
    if (busy) return;
    if (gates.issues.length > 0) {
      onboarding.revealIssues();
      // Move focus to the first problem so a keyboard / screen-reader user lands on it.
      const first = gates.issues[0]!.field;
      requestAnimationFrame(() => document.getElementById(`${baseId}-${first}`)?.focus());
      return;
    }
    requestDuplicatesResultFocus();
    void onboarding.checkDuplicates();
  };

  const text = (field: FormFieldKey, label: string, options: { required?: boolean; type?: string; hint?: string; value: string; autoComplete?: string; inputMode?: "email" | "tel" | "text"; full?: boolean }) => {
    const id = `${baseId}-${field}`;
    const error = errorOf(field);
    const describedBy = [options.hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
    return (
      <div className={`field${options.full ? " full" : ""}`}>
        <label htmlFor={id}>
          {label} {options.required && REQUIRED}
        </label>
        <input id={id} type={options.type ?? "text"} inputMode={options.inputMode} autoComplete={options.autoComplete ?? "off"} value={options.value} disabled={locked} aria-required={options.required || undefined} aria-invalid={error ? true : undefined} aria-describedby={describedBy} onChange={(event) => onboarding.edit(field, event.target.value)} onBlur={() => touch(field)} />
        {options.hint && <small id={`${id}-hint`}>{options.hint}</small>}
        {error && (
          <small id={`${id}-error`} role="alert" style={{ color: "var(--red)" }}>
            {error}
          </small>
        )}
      </div>
    );
  };

  const regionId = `${baseId}-regionId`;
  const regionError = errorOf("regionId");
  const vendorTypeId = `${baseId}-vendorType`;
  const vendorTypeError = errorOf("vendorType");

  return (
    <WizardBlock anchorId={ONBOARDING_STEP_ANCHORS.record} number={2} title={`New ${noun} details`} description={`This is the ${noun} record that would be created. Values found in the Agreement are prefilled. Review every field.`}>
      {!previewReady && (
        <p className="foundationnote" style={{ marginTop: 0 }}>
          Read the signed Agreement above first. The details it states will be filled in here for you to review.
        </p>
      )}
      {notes.length > 0 && (
        <ul className="foundationnote" style={{ margin: "0 0 10px 18px", padding: 0, display: "grid", gap: 3 }} aria-label="Notes about the prefilled details">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      {previewReady && (
        <>
          <div className="fields">
            {text("displayName", "Name", { required: true, value: state.form.displayName, autoComplete: "name" })}
            {text("legalName", "Legal name", { value: state.form.legalName, hint: "If different from the name." })}
            {text("email", "Email address", { type: "email", inputMode: "email", value: state.form.email, autoComplete: "email" })}
            {text("phone", "Phone number", { type: "tel", inputMode: "tel", value: state.form.phone, autoComplete: "tel", hint: "Digits, with an optional + and spaces." })}

            <div className="field">
              <label htmlFor={regionId}>State / region {REQUIRED}</label>
              <select id={regionId} value={state.form.regionId} disabled={locked} aria-required="true" aria-invalid={regionError ? true : undefined} aria-describedby={`${regionId}-hint${regionError ? ` ${regionId}-error` : ""}`} onChange={(event) => onboarding.edit("regionId", event.target.value)} onBlur={() => touch("regionId")}>
                <option value="">Choose a region…</option>
                {REGION_GROUPS.map((group) => (
                  <optgroup key={group.zone} label={group.zone}>
                    {group.regions.map((region) => (
                      <option key={region} value={region}>
                        {region}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <small id={`${regionId}-hint`}>The new {noun} is created in this region. It must be one you have access to.</small>
              {regionError && (
                <small id={`${regionId}-error`} role="alert" style={{ color: "var(--red)" }}>
                  {regionError}
                </small>
              )}
            </div>

            {type === "VENDOR" && (
              <div className="field">
                <label htmlFor={vendorTypeId}>Vendor type {REQUIRED}</label>
                <select id={vendorTypeId} value={state.form.vendorType} disabled={locked} aria-required="true" aria-invalid={vendorTypeError ? true : undefined} aria-describedby={vendorTypeError ? `${vendorTypeId}-error` : undefined} onChange={(event) => onboarding.edit("vendorType", event.target.value)} onBlur={() => touch("vendorType")}>
                  <option value="">Choose a type…</option>
                  {ONBOARDING_VENDOR_TYPES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {vendorTypeError && (
                  <small id={`${vendorTypeId}-error`} role="alert" style={{ color: "var(--red)" }}>
                    {vendorTypeError}
                  </small>
                )}
              </div>
            )}
          </div>

          {type === "PARTNER" && (
            <div style={{ marginTop: 14 }}>
              <b style={{ fontSize: 11, fontWeight: 550 }}>Partner {state.form.accounts.length === 1 ? "Account" : "Accounts"}</b>
              <p style={{ fontSize: 11, color: "var(--muted)", margin: "2px 0 8px" }}>
                {state.form.accounts.length > 1 ? "One Partner with a separate account on each platform. " : ""}
                Each account is identified by its page link (preferred) or its handle. A name alone never identifies an account.
              </p>
              <div style={{ display: "grid", gap: 12 }}>
                {state.form.accounts.map((row, index) => (
                  <AccountRow key={row.platform} index={index} baseId={baseId} disabled={locked} errorOf={errorOf} touch={touch} />
                ))}
              </div>
            </div>
          )}

          <div className="actions" style={{ marginTop: 16, alignItems: "center" }}>
            <button type="button" className="btn primary" onClick={check} disabled={busy || locked} aria-disabled={busy || locked} style={busy || locked ? DISABLED_BUTTON_STYLE : undefined} data-testid="onboarding-check-duplicates">
              {checking ? "Checking…" : `Check for existing ${noun}`}
            </button>
            {gates.issues.length > 0 && !state.showIssues && <small className="muted">Complete the required details, then check for an existing {noun}.</small>}
          </div>
          {state.showIssues && gates.issues.length > 0 && !locked && (
            <div className="banner" role="alert" style={{ margin: "12px 0 0" }} data-testid="onboarding-form-issues">
              <span>
                <b>Before you continue</b>
                <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
                  {gates.issues.map((issue) => (
                    <li key={issue.field}>{issue.message}</li>
                  ))}
                </ul>
              </span>
            </div>
          )}
        </>
      )}
    </WizardBlock>
  );
}

function AccountRow({ index, baseId, disabled, errorOf, touch }: { index: number; baseId: string; disabled: boolean; errorOf: (field: FormFieldKey) => string | null; touch: (field: FormFieldKey) => void }) {
  const { onboarding } = useIntake();
  const row = onboarding.state.form.accounts[index]!;
  const platform = formatPlatformName(row.platform);
  const locatorField = accountFieldKey(index, "locator");
  const locatorId = `${baseId}-${locatorField}`;
  const nameField = accountFieldKey(index, "pageName");
  const nameId = `${baseId}-${nameField}`;
  const kindName = `${baseId}-kind-${index}`;
  const locatorError = errorOf(locatorField);
  const nameError = errorOf(nameField);
  const kinds: Array<{ value: LocatorKind; label: string }> = [
    { value: "LINK", label: "Page link" },
    { value: "HANDLE", label: "Handle" },
  ];
  return (
    <fieldset className="field full" style={{ border: "1px solid var(--line)", borderRadius: 9, padding: "12px 14px", margin: 0, minWidth: 0 }} data-testid={`onboarding-account-${row.platform}`}>
      <legend style={{ fontSize: 11, fontWeight: 550, padding: "0 4px" }}>{platform} account</legend>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }} role="radiogroup" aria-label={`Identify the ${platform} account by`}>
        <span style={{ fontSize: 11 }}>Identify by</span>
        {kinds.map((kind) => (
          <label key={kind.value} style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12, fontWeight: 400 }}>
            <input type="radio" name={kindName} value={kind.value} checked={row.locatorKind === kind.value} disabled={disabled} onChange={() => onboarding.edit(accountFieldKey(index, "locatorKind"), kind.value)} style={{ width: "auto", margin: 0 }} />
            {kind.label}
          </label>
        ))}
      </div>
      <div className="fields">
        <div className="field">
          <label htmlFor={locatorId}>
            {row.locatorKind === "LINK" ? `${platform} page link` : `${platform} handle`} {REQUIRED}
          </label>
          <input id={locatorId} type="text" inputMode={row.locatorKind === "LINK" ? "url" : "text"} autoComplete="off" value={row.locator} disabled={disabled} aria-required="true" aria-invalid={locatorError ? true : undefined} aria-describedby={locatorError ? `${locatorId}-error` : undefined} onChange={(event) => onboarding.edit(locatorField, event.target.value)} onBlur={() => touch(locatorField)} />
          {locatorError && (
            <small id={`${locatorId}-error`} role="alert" style={{ color: "var(--red)" }}>
              {locatorError}
            </small>
          )}
        </div>
        <div className="field">
          <label htmlFor={nameId}>Page or account name</label>
          <input id={nameId} type="text" autoComplete="off" value={row.pageName} disabled={disabled} aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? `${nameId}-error` : undefined} onChange={(event) => onboarding.edit(nameField, event.target.value)} onBlur={() => touch(nameField)} />
          {nameError && (
            <small id={`${nameId}-error`} role="alert" style={{ color: "var(--red)" }}>
              {nameError}
            </small>
          )}
        </div>
      </div>
    </fieldset>
  );
}
