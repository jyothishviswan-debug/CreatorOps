"use client";

// Step 14C.3, IA section 6 "New counterparty from Agreement": upload the signed Agreement, extract a proposed identity,
// review/edit the proposed new record, check for a duplicate, then either use the existing match or deliberately create
// new. Replaces sections 2-4 until the Partner/Vendor exists. Same pure onboarding logic as before (wizard-form.ts,
// wizard-state.ts, duplicate-rules.ts, create-progress.ts, preview-view.ts, confirmed-values.ts) - only the JSX is new,
// and it is ONE cohesive flow instead of four separate blocks.
import { useId, useRef, type ChangeEvent } from "react";

import { Pill } from "@/ui/Badge";

import { DISABLED_BUTTON_STYLE, KYC_AVAILABLE_NOTE, formatFileSize } from "../format";
import { KYC_LATER_NOTE, confirmedRows, decisionRow } from "../agreement-intake-logic/onboarding/confirmed-values";
import { stepRows } from "../agreement-intake-logic/onboarding/create-progress";
import { NO_STRONG_MATCH_HEADING, candidateCards, summarizeDuplicates } from "../agreement-intake-logic/onboarding/duplicate-rules";
import { issueFor, ONBOARDING_VENDOR_TYPES, type FormFieldKey } from "../agreement-intake-logic/onboarding/wizard-form";
import { INTAKE_BUSY, useIntake } from "../agreement-intake-logic/intake-context";
import { agreementFacts, commercialFoundLabels, detectedPlatformText, identityFoundLines, previewAnnouncement, previewRows, safeSnippets, summarizePreview } from "../agreement-intake-logic/onboarding/preview-view";

import { SectionCard } from "./SectionCard";

export function NewPartyOnboarding() {
  const intake = useIntake();
  const { onboarding } = intake;
  const noun = onboarding.type === "PARTNER" ? "Partner" : "Vendor";
  return (
    <SectionCard sectionKey="identity" title={`New ${noun} from Agreement`} description={`Read the signed Agreement, check whether the ${noun} already exists, then create it. Nothing is created until the last step.`}>
      <UploadStep />
      <RecordStep />
      <DuplicatesStep />
      <CreateStep />
    </SectionCard>
  );
}

// --- 1. Upload + extract -----------------------------------------------------------------------------------------------------------------
function UploadStep() {
  const { onboarding, isBusy } = useIntake();
  const { state, gates } = onboarding;
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const busy = isBusy();
  const previewing = state.preview.status === "loading" || isBusy(INTAKE_BUSY.onboardPreview);
  const preview = state.preview.status === "ready" ? state.preview.data : null;
  const summary = preview ? summarizePreview(preview) : null;
  const announcement = previewAnnouncement({ loading: previewing, preview, failure: state.preview.status === "error" ? state.preview.message : null, fileName: state.file?.name ?? null });
  const runnable = gates.canPreview && !busy;

  const onFile = (event: ChangeEvent<HTMLInputElement>) => onboarding.pickFile(event.target.files?.[0]);
  const onExtract = async () => {
    if (!runnable) return;
    await onboarding.extractPreview();
  };

  return (
    <div style={{ marginBottom: 18 }}>
      <FieldGroupHeading>1. Signed Agreement</FieldGroupHeading>
      <div className="field">
        <label htmlFor={inputId}>Agreement PDF</label>
        <input ref={fileInputRef} id={inputId} type="file" accept="application/pdf,.pdf" onChange={onFile} disabled={busy || gates.locked} style={{ width: "100%" }} />
        <small>PDF only · up to 10 MB</small>
        {state.fileError && (
          <small role="alert" style={{ color: "var(--red)" }}>
            {state.fileError}
          </small>
        )}
        {state.file && (
          <small style={{ overflowWrap: "anywhere" }}>
            Selected: <b>{state.file.name}</b> · {formatFileSize(state.file.size)}
          </small>
        )}
      </div>
      <div className="actions" style={{ marginTop: 10, alignItems: "center" }}>
        <button type="button" className="btn primary" onClick={onExtract} disabled={!runnable} style={!runnable ? DISABLED_BUTTON_STYLE : undefined}>
          {previewing ? "Reading Agreement…" : "Extract from Agreement"}
        </button>
        {!state.file && !previewing && <small className="muted">Choose a PDF to enable extraction.</small>}
      </div>
      <div role="status" aria-live="polite" style={{ marginTop: announcement ? 10 : 0 }}>
        {announcement && <small style={{ color: announcement.tone === "warning" ? "var(--orange)" : announcement.tone === "error" ? "var(--red)" : undefined }}>{announcement.text}</small>}
      </div>
      {preview && summary && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <b style={{ fontSize: 12 }}>Extracted from Agreement</b>
            <small className="muted">
              {summary.chip.label}
              {summary.pageCount !== null ? ` · ${summary.pageCount} ${summary.pageCount === 1 ? "page" : "pages"}` : ""}
            </small>
          </div>
          {summary.scanMessage && (
            <div className="banner" role="status" style={{ margin: "8px 0 0" }}>
              <span>{summary.scanMessage}</span>
            </div>
          )}
          {summary.foundValues && (
            <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
              {previewRows(preview).map((row) => (
                <div className="kv" key={row.key}>
                  <span>{row.label}</span>
                  <b style={{ fontWeight: 500 }}>
                    {row.value ?? <span className="muted">Not found</span>}
                    {row.key === "collaboratorPageLink" && detectedPlatformText(preview) && ` · ${detectedPlatformText(preview)}`}
                  </b>
                </div>
              ))}
            </div>
          )}
          <AlsoFound preview={preview} />
          <p className="foundationnote" style={{ marginTop: 10 }}>
            {summary.note}
          </p>
        </div>
      )}
    </div>
  );
}

function AlsoFound({ preview }: { preview: Parameters<typeof agreementFacts>[0] }) {
  const facts = agreementFacts(preview);
  const commercial = commercialFoundLabels(preview);
  const identity = identityFoundLines(preview);
  const snippets = safeSnippets(preview);
  if (facts.length === 0 && commercial.length === 0 && identity.length === 0 && snippets.length === 0) return null;
  return (
    <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
      {facts.map((fact) => (
        <div className="kv" key={fact.label}>
          <span>{fact.label}</span>
          <b style={{ fontWeight: 500 }}>{fact.value}</b>
        </div>
      ))}
      {commercial.length > 0 && (
        <div>
          <small>
            <b>Terms the Agreement states: </b>
            {commercial.join(", ")}
          </small>
        </div>
      )}
      {identity.length > 0 && (
        <div>
          <small>
            <b>Identity details: </b>
            {identity.join(", ")}
          </small>
        </div>
      )}
      {snippets.length > 0 && (
        <details>
          <summary style={{ fontSize: 11, cursor: "pointer" }}>Contract text</summary>
          <div style={{ display: "grid", gap: 4, marginTop: 4 }}>
            {snippets.map((snippet) => (
              <small key={snippet.key} className="muted" style={{ overflowWrap: "anywhere" }}>
                {snippet.page !== null ? `Page ${snippet.page}: ` : ""}
                {snippet.text}
              </small>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function FieldGroupHeading({ children }: { children: React.ReactNode }) {
  return <h3 style={{ fontSize: 13, margin: "0 0 8px" }}>{children}</h3>;
}

// --- 2. Proposed new record ---------------------------------------------------------------------------------------------------------------
function RecordStep() {
  const { onboarding, isBusy } = useIntake();
  const { state, gates } = onboarding;
  if (state.preview.status !== "ready") return null;
  const busy = isBusy() || gates.locked;
  const isPartner = onboarding.type === "PARTNER";
  const edit = (field: FormFieldKey, value: string) => onboarding.edit(field, value);

  return (
    <div style={{ marginBottom: 18 }}>
      <FieldGroupHeading>2. New {onboarding.type === "PARTNER" ? "Partner" : "Vendor"} details</FieldGroupHeading>
      <p className="foundationnote" style={{ marginTop: -4, marginBottom: 10 }}>
        Values found in the Agreement are prefilled. Review every field - typing over a field stops it from being prefilled again.
      </p>
      <div className="fields">
        <div className="field">
          <label htmlFor="ob-name">Name *</label>
          <input id="ob-name" type="text" disabled={busy} value={state.form.displayName} onChange={(event) => edit("displayName", event.target.value)} />
          <FieldIssue field="displayName" />
        </div>
        <div className="field">
          <label htmlFor="ob-legal">Legal name</label>
          <input id="ob-legal" type="text" disabled={busy} value={state.form.legalName} onChange={(event) => edit("legalName", event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ob-email">Email address</label>
          <input id="ob-email" type="email" disabled={busy} value={state.form.email} onChange={(event) => edit("email", event.target.value)} />
          <FieldIssue field="email" />
        </div>
        <div className="field">
          <label htmlFor="ob-phone">Phone number</label>
          <input id="ob-phone" type="tel" disabled={busy} value={state.form.phone} onChange={(event) => edit("phone", event.target.value)} />
          <small>Digits, with an optional + and spaces.</small>
        </div>
        <div className="field">
          <label htmlFor="ob-region">State / region *</label>
          <select id="ob-region" disabled={busy} value={state.form.regionId} onChange={(event) => edit("regionId", event.target.value)}>
            <option value="">Choose a state…</option>
            {["Kerala", "Maharashtra", "Tamil Nadu", "Karnataka"].map((region) => (
              <option key={region} value={region}>
                {region}
              </option>
            ))}
          </select>
          <small>The new {onboarding.type === "PARTNER" ? "Partner" : "Vendor"} is created in this region.</small>
        </div>
        {!isPartner && (
          <div className="field">
            <label htmlFor="ob-vendor-type">Vendor type</label>
            <select id="ob-vendor-type" disabled={busy} value={state.form.vendorType} onChange={(event) => edit("vendorType", event.target.value)}>
              <option value="">Choose a type…</option>
              {ONBOARDING_VENDOR_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {isPartner && (
        <div style={{ marginTop: 14 }}>
          <b style={{ fontSize: 12 }}>Partner Account{state.form.accounts.length === 1 ? "" : "s"}</b>
          {state.form.accounts.map((row, index) => (
            <div key={row.platform} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, marginTop: 8 }}>
              <b style={{ fontSize: 12, textTransform: "capitalize" }}>{row.platform} account</b>
              <div style={{ display: "flex", gap: 14, alignItems: "center", margin: "8px 0" }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                  <input type="radio" name={`locator-kind-${index}`} checked={row.locatorKind === "LINK"} disabled={busy} onChange={() => edit(`account.${index}.locatorKind`, "LINK")} /> Page link
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                  <input type="radio" name={`locator-kind-${index}`} checked={row.locatorKind === "HANDLE"} disabled={busy} onChange={() => edit(`account.${index}.locatorKind`, "HANDLE")} /> Handle
                </label>
              </div>
              <div className="fields">
                <div className="field">
                  <label htmlFor={`ob-locator-${index}`}>{row.locatorKind === "LINK" ? "Page link *" : "Handle *"}</label>
                  <input id={`ob-locator-${index}`} type="text" disabled={busy} value={row.locator} onChange={(event) => edit(`account.${index}.locator`, event.target.value)} />
                  <FieldIssue field={`account.${index}.locator`} />
                </div>
                <div className="field">
                  <label htmlFor={`ob-name-${index}`}>Page or account name</label>
                  <input id={`ob-name-${index}`} type="text" disabled={busy} value={row.pageName} onChange={(event) => edit(`account.${index}.pageName`, event.target.value)} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="foundationnote" style={{ marginTop: 10 }}>
        {KYC_LATER_NOTE}
      </p>
    </div>
  );
}

function FieldIssue({ field }: { field: FormFieldKey }) {
  const { onboarding } = useIntake();
  if (!onboarding.state.showIssues) return null;
  const message = issueFor(onboarding.gates.issues, field);
  if (!message) return null;
  return (
    <small role="alert" style={{ color: "var(--red)" }}>
      {message}
    </small>
  );
}

// --- 3. Duplicate check ---------------------------------------------------------------------------------------------------------------------
function DuplicatesStep() {
  const { onboarding, isBusy } = useIntake();
  const { state, gates } = onboarding;
  if (state.preview.status !== "ready") return null;
  const busy = isBusy() || gates.locked;
  const checking = isBusy(INTAKE_BUSY.onboardDuplicates);
  const dto = state.duplicates.load.status === "ready" ? state.duplicates.load.data : null;
  const summary = dto ? summarizeDuplicates(dto) : null;
  const cards = dto ? candidateCards(dto) : [];

  return (
    <div style={{ marginBottom: 18 }}>
      <FieldGroupHeading>3. Check for an existing {onboarding.type === "PARTNER" ? "Partner" : "Vendor"}</FieldGroupHeading>
      <p className="foundationnote" style={{ marginTop: -4, marginBottom: 10 }}>
        Before anything is created, CreatorOps looks for a record with the same email, phone or account. A name match alone is only a hint.
      </p>
      <div className="actions">
        <button type="button" className="btn" onClick={() => void onboarding.checkDuplicates()} disabled={!gates.canCheck || busy} style={!gates.canCheck || busy ? DISABLED_BUTTON_STYLE : undefined}>
          {checking ? "Checking…" : "Check for existing"}
        </button>
      </div>
      {state.duplicates.load.status === "error" && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          <span>{state.duplicates.load.message}</span>
        </div>
      )}
      {summary && (
        <div style={{ marginTop: 12 }}>
          {summary.kind === "none" ? (
            <div className="scopebox">
              <b>{NO_STRONG_MATCH_HEADING}</b>
              <p style={{ margin: "4px 0 0" }}>{summary.message}</p>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              <div className="scopebox">
                <b>{summary.heading}</b>
                <p style={{ margin: "4px 0 0" }}>{summary.message}</p>
              </div>
              {cards.map((card) => (
                <div key={card.ref} className="record">
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
                    <b style={{ fontSize: 13 }}>{card.displayName}</b>
                    <Pill tone={card.strength === "STRONG" ? undefined : "blue"}>{card.strengthLabel}</Pill>
                  </div>
                  <p className="detailcopy" style={{ margin: "4px 0" }}>{card.regionsText}{card.inactive ? " · Inactive" : ""}</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "6px 0" }}>
                    {card.signals.map((signal) => (
                      <Pill key={signal} tone="gray">
                        {signal}
                      </Pill>
                    ))}
                  </div>
                  <div className="actions">
                    <button type="button" className="btn primary" disabled={busy || card.inactive} onClick={() => onboarding.chooseExisting(card.ref)} style={busy || card.inactive ? DISABLED_BUTTON_STYLE : undefined}>
                      Use this {onboarding.type === "PARTNER" ? "Partner" : "Vendor"}
                    </button>
                  </div>
                </div>
              ))}
              <div className="actions">
                <button type="button" className="btn ghost" disabled={busy} onClick={() => onboarding.continueNew()}>
                  None of these - create new
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- 4. Confirm and create -------------------------------------------------------------------------------------------------------------
function CreateStep() {
  const { onboarding, isBusy } = useIntake();
  const { state, gates } = onboarding;
  const id = useId();
  if (state.preview.status !== "ready" || state.duplicates.load.status !== "ready") return null;
  const busy = isBusy() || gates.locked;
  const creating = isBusy(INTAKE_BUSY.onboardCreate);
  const dto = state.duplicates.load.data;
  const decisionSummary = decisionRow(onboarding.type, gates.decision, dto);
  const rows = confirmedRows({ type: onboarding.type, form: state.form, decision: gates.decision, duplicates: dto });
  const outcome = onboarding.outcomeView;
  const context = { type: onboarding.type, mode: gates.decision.kind === "USE_EXISTING" ? ("USE_EXISTING" as const) : ("CREATE_NEW" as const), accountCount: state.form.accounts.length, running: creating };
  const steps = stepRows(state.create.status === "outcome" ? state.create.outcome : null, context);

  return (
    <div>
      <FieldGroupHeading>4. Confirm and create</FieldGroupHeading>
      <div className="kv">
        <span>What happens</span>
        <b>{decisionSummary.value}</b>
      </div>
      {rows.map((row) => (
        <div className="kv" key={row.label}>
          <span>{row.label}</span>
          <b className={row.muted ? "muted" : undefined}>{row.value}</b>
        </div>
      ))}

      {gates.decision.kind === "CREATE_NEW" && (
        <div style={{ marginTop: 10 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12 }}>
            <input type="checkbox" checked={gates.decision.acknowledged} disabled={busy} onChange={(event) => onboarding.setAcknowledged(event.target.checked)} style={{ marginTop: 2 }} />
            <span>I checked the possible matches above and confirm this is a new, distinct {onboarding.type === "PARTNER" ? "Partner" : "Vendor"}.</span>
          </label>
          {!gates.decisionReady && gates.decisionMessage && (
            <small className="muted" style={{ display: "block", marginTop: 4 }}>
              {gates.decisionMessage}
            </small>
          )}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, margin: "12px 0" }}>
        {steps.map((step) => (
          <Pill key={step.step} tone={step.state === "done" ? undefined : step.state === "failed" ? "red" : step.state === "current" ? "orange" : "gray"}>
            {step.label}
          </Pill>
        ))}
      </div>

      {outcome && (
        <div className="banner" role={outcome.tone === "error" ? "alert" : "status"} style={{ borderColor: outcome.tone === "error" ? "#e8c2c6" : undefined, background: outcome.tone === "error" ? "#fdf6f6" : undefined }}>
          <span>{outcome.message}</span>
        </div>
      )}

      <div className="actions" style={{ marginTop: 10 }}>
        <button type="button" className="btn primary" onClick={() => void onboarding.create()} disabled={!gates.canCreate || busy} style={!gates.canCreate || busy ? DISABLED_BUTTON_STYLE : undefined}>
          {creating ? "Creating…" : outcome?.action === "RETRY" ? "Retry" : outcome?.action === "CHECK_AGAIN" ? "Check again" : `Create ${onboarding.type === "PARTNER" ? "Partner" : "Vendor"} and start Agreement`}
        </button>
        {outcome?.action === "START_AGAIN" && (
          <button type="button" className="btn ghost" onClick={onboarding.startAgain} disabled={busy}>
            Start again
          </button>
        )}
      </div>
      {!gates.canCreate && gates.createBlockedReason && <p className="foundationnote">{gates.createBlockedReason}</p>}
      <p className="foundationnote" style={{ marginTop: 8 }}>
        {gates.decision.kind === "USE_EXISTING" ? KYC_AVAILABLE_NOTE : "Nothing is created until you confirm this last step."}
      </p>
      <div id={`${id}-status`} className="sr" role="status" aria-live="polite" />
    </div>
  );
}
