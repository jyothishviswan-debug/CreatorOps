"use client";

// Step 14C.3: `Upload / Update` for ONE KYC component that is Missing or Incomplete. Offers only the canonical owning-module
// paths - Finance keeps no KYC copy of its own: apply the value found in the Agreement, type the value directly (writes
// straight to the Partner/Vendor restricted-identity record), add evidence, or open the record. Built on DialogShell.
import { useId, useRef, useState } from "react";

import { DialogShell } from "@/ui/Dialog";

import { addKycLinkEvidence, saveKycRestrictedIdentity, uploadKycEvidenceFile, type SaveKycIdentityInput } from "../api-client";
import { DISABLED_BUTTON_STYLE, KYC_COMPONENT_LABELS, counterpartyTypeLabel, type KycComponentKey } from "../format";
import { BANK_NOT_FROM_CONTRACT, KYC_APPLY_FIELD, KYC_DOC_TYPES, evaluateApplyOption, extractionHasIdentityValue, kycDialogIntro, kycDialogTitle, owningRecordHref, validateEvidenceFile, validateEvidenceLink, type KycDialogKind } from "../agreement-intake-logic/kyc-ui";
import { readIdentityRecordVersion } from "../agreement-intake-logic/owning-versions";
import { useIntake } from "../agreement-intake-logic/intake-context";

function Option({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <section style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, display: "grid", gap: 8, minWidth: 0 }} aria-label={`Option ${number}: ${title}`}>
      <b style={{ fontSize: 12 }}>{`${number}. ${title}`}</b>
      {children}
    </section>
  );
}

const NO_RECORD_MESSAGE = "There is no KYC record for this Partner or Vendor yet, so evidence cannot be added. Enter the details here first (option 2), or on the Partner / Vendor record (option 4).";

export function KycDialog({ component, kind, onClose }: { component: KycComponentKey; kind: KycDialogKind; onClose: () => void }) {
  const intake = useIntake();
  const { counterparty, flags, permissions, extraction, extractionAttached, getField } = intake;
  const base = useId();
  const [link, setLink] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<null | "apply" | "manual" | "link" | "file">(null);
  const guard = useRef(false);

  const [pan, setPan] = useState("");
  const [aadhaar, setAadhaar] = useState("");
  const [accountHolderName, setAccountHolderName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [bankName, setBankName] = useState("");
  const [branchName, setBranchName] = useState("");
  const [gstApplicable, setGstApplicable] = useState(false);
  const [gstNumber, setGstNumber] = useState("");

  if (!counterparty) return null;
  const label = KYC_COMPONENT_LABELS[component];
  const noun = counterpartyTypeLabel(counterparty.type);
  const busy = submitting !== null || intake.isBusy();
  const vendorAadhaar = counterparty.type === "VENDOR" && component === "aadhaar";

  const apply = evaluateApplyOption({
    component,
    counterpartyType: counterparty.type,
    extractionState: !extraction ? "none" : extractionAttached ? "attached" : "not_attached",
    extractedValueUsable: component !== "bank" && extractionHasIdentityValue(extraction, component),
    identityDecision: component === "bank" ? null : (getField(KYC_APPLY_FIELD[component])?.decision ?? null),
    canViewContractDetail: permissions.canViewContractDetail,
    canManageKyc: flags.canManageCounterpartyKyc,
    canViewIdentity: flags.canViewIdentity,
    componentMissing: true,
  });

  const close = () => {
    if (guard.current) return;
    onClose();
  };

  const run = async (kind: "apply" | "manual" | "link" | "file", work: () => Promise<{ ok: boolean; message?: string; aborted?: boolean }>) => {
    if (guard.current) return;
    guard.current = true;
    setSubmitting(kind);
    setError(null);
    try {
      const outcome = await work();
      if (outcome.ok) {
        void intake.refreshKyc();
        if (intake.reconciliation !== null) void intake.refreshReconciliation();
        onClose();
      } else if (!outcome.aborted && outcome.message) setError(outcome.message);
    } finally {
      guard.current = false;
      setSubmitting(null);
    }
  };

  const applyFromAgreement = () =>
    run("apply", async () => {
      const result = await intake.applyExtractedKyc({ components: [component], mode: "FILL_MISSING" });
      return result.ok ? { ok: true } : { ok: false, message: result.message, aborted: result.aborted };
    });

  const identityVersion = async (): Promise<{ ok: true; version: number } | { ok: false; message: string }> => {
    const read = await readIdentityRecordVersion(counterparty.type, counterparty.ref);
    if (!read.ok) return read;
    if (read.version === 0) return { ok: false, message: NO_RECORD_MESSAGE };
    return read;
  };

  const saveManually = () => {
    let value: Omit<SaveKycIdentityInput, "expectedVersion"> | null = null;
    if (component === "pan") {
      if (!pan.trim()) return setError("Enter the PAN.");
      value = { pan: { number: pan.trim() } };
    } else if (component === "aadhaar") {
      if (!aadhaar.trim()) return setError("Enter the Aadhaar number.");
      value = { aadhaar: { number: aadhaar.trim() } };
    } else if (component === "bank") {
      if (!accountHolderName.trim() || !accountNumber.trim() || !ifsc.trim() || !bankName.trim() || !branchName.trim()) return setError("Enter every bank detail.");
      value = { bank: { accountHolderName: accountHolderName.trim(), accountNumber: accountNumber.trim(), ifsc: ifsc.trim(), bankName: bankName.trim(), branchName: branchName.trim() } };
    } else {
      if (gstApplicable && !gstNumber.trim()) return setError("Enter the GST number, or leave GST applicable unchecked.");
      value = { gst: { applicable: gstApplicable, number: gstApplicable ? gstNumber.trim() : undefined } };
    }
    setError(null);
    const toSave = value;
    void run("manual", async () => {
      const version = await readIdentityRecordVersion(counterparty.type, counterparty.ref);
      if (!version.ok) return { ok: false, message: version.message };
      const result = await saveKycRestrictedIdentity({ counterpartyType: counterparty.type, ref: counterparty.ref, value: { ...toSave, expectedVersion: version.version } });
      if (result.ok) intake.notify("success", `The ${label} was saved to the ${noun} record.`, "kyc-manual");
      return result.ok ? { ok: true } : { ok: false, message: result.message, aborted: result.aborted };
    });
  };

  const addLink = () => {
    const checked = validateEvidenceLink(link);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    void run("link", async () => {
      const version = await identityVersion();
      if (!version.ok) return version;
      const result = await addKycLinkEvidence({ counterpartyType: counterparty.type, ref: counterparty.ref, docType: KYC_DOC_TYPES[component], url: checked.value, expectedVersion: version.version });
      if (result.ok) intake.notify("success", `A link for the ${label} was added to the ${noun} record.`, "kyc-evidence");
      return result.ok ? { ok: true } : { ok: false, message: result.message, aborted: result.aborted };
    });
  };

  const uploadFile = () => {
    if (!file) {
      setError("Choose a document to upload.");
      return;
    }
    const problem = validateEvidenceFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    void run("file", async () => {
      const version = await identityVersion();
      if (!version.ok) return version;
      const result = await uploadKycEvidenceFile({ counterpartyType: counterparty.type, ref: counterparty.ref, docType: KYC_DOC_TYPES[component], file, expectedVersion: version.version });
      if (result.ok) intake.notify("success", `The ${label} document was added to the ${noun} record.`, "kyc-evidence");
      return result.ok ? { ok: true } : { ok: false, message: result.message, aborted: result.aborted };
    });
  };

  return (
    <DialogShell
      open
      title={kycDialogTitle(component, kind)}
      onClose={close}
      footer={
        <button type="button" className="btn ghost" onClick={close} disabled={submitting !== null} style={submitting !== null ? DISABLED_BUTTON_STYLE : undefined}>
          Close
        </button>
      }
    >
      <p className="detailcopy">{kycDialogIntro(component, kind, counterparty.type)}</p>

      <div style={{ display: "grid", gap: 12 }}>
        <Option number={1} title="Apply the value found in the Agreement">
          {component === "bank" ? (
            <small className="muted">{BANK_NOT_FROM_CONTRACT}</small>
          ) : (
            <>
              <small className="muted">{`Fills the empty ${label} in the ${noun} record with the value found in the Agreement.`}</small>
              {!apply.available && (
                <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 11 }}>
                  {apply.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
              <div>
                <button type="button" className="btn" onClick={() => void applyFromAgreement()} disabled={busy || !apply.available} style={busy || !apply.available ? DISABLED_BUTTON_STYLE : undefined}>
                  {submitting === "apply" ? "Applying…" : "Apply from Agreement"}
                </button>
              </div>
            </>
          )}
        </Option>

        <Option number={2} title="Enter the value directly">
          {vendorAadhaar ? (
            <small className="muted">Aadhaar applies to Partners only.</small>
          ) : (
            <>
              <small className="muted">{`Saved straight to the ${noun}'s own restricted identity record.`}</small>
              {component === "pan" && (
                <div className="field">
                  <label htmlFor={`${base}-pan`}>PAN</label>
                  <input id={`${base}-pan`} type="text" autoComplete="off" value={pan} disabled={busy} onChange={(event) => setPan(event.target.value)} style={{ width: "100%" }} />
                </div>
              )}
              {component === "aadhaar" && (
                <div className="field">
                  <label htmlFor={`${base}-aadhaar`}>Aadhaar number</label>
                  <input id={`${base}-aadhaar`} type="text" autoComplete="off" value={aadhaar} disabled={busy} onChange={(event) => setAadhaar(event.target.value)} style={{ width: "100%" }} />
                </div>
              )}
              {component === "bank" && (
                <div className="fields">
                  <div className="field">
                    <label htmlFor={`${base}-holder`}>Account holder name</label>
                    <input id={`${base}-holder`} type="text" autoComplete="off" value={accountHolderName} disabled={busy} onChange={(event) => setAccountHolderName(event.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor={`${base}-account`}>Account number</label>
                    <input id={`${base}-account`} type="text" autoComplete="off" value={accountNumber} disabled={busy} onChange={(event) => setAccountNumber(event.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor={`${base}-ifsc`}>IFSC</label>
                    <input id={`${base}-ifsc`} type="text" autoComplete="off" value={ifsc} disabled={busy} onChange={(event) => setIfsc(event.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor={`${base}-bank-name`}>Bank name</label>
                    <input id={`${base}-bank-name`} type="text" autoComplete="off" value={bankName} disabled={busy} onChange={(event) => setBankName(event.target.value)} />
                  </div>
                  <div className="field full">
                    <label htmlFor={`${base}-branch-name`}>Branch name</label>
                    <input id={`${base}-branch-name`} type="text" autoComplete="off" value={branchName} disabled={busy} onChange={(event) => setBranchName(event.target.value)} />
                  </div>
                </div>
              )}
              {component === "gst" && (
                <>
                  <label htmlFor={`${base}-gst-applicable`} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                    <input id={`${base}-gst-applicable`} type="checkbox" checked={gstApplicable} disabled={busy} onChange={(event) => setGstApplicable(event.target.checked)} />
                    GST applicable
                  </label>
                  {gstApplicable && (
                    <div className="field">
                      <label htmlFor={`${base}-gst-number`}>GST number</label>
                      <input id={`${base}-gst-number`} type="text" autoComplete="off" value={gstNumber} disabled={busy} onChange={(event) => setGstNumber(event.target.value)} style={{ width: "100%" }} />
                    </div>
                  )}
                </>
              )}
              <div>
                <button type="button" className="btn" onClick={saveManually} disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined}>
                  {submitting === "manual" ? "Saving…" : `Save ${label.toLowerCase()}`}
                </button>
              </div>
            </>
          )}
        </Option>

        <Option number={3} title="Add a document link or upload a document">
          {vendorAadhaar ? (
            <small className="muted">Aadhaar applies to Partners only.</small>
          ) : (
            <>
              <small className="muted">{`The document is added to the ${noun} record's own evidence.`}</small>
              <div className="field">
                <label htmlFor={`${base}-link`}>{`${label} document link`}</label>
                <input id={`${base}-link`} type="url" inputMode="url" autoComplete="off" value={link} disabled={busy} onChange={(event) => setLink(event.target.value)} style={{ width: "100%" }} placeholder="https://" />
              </div>
              <div>
                <button type="button" className="btn" onClick={addLink} disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined}>
                  {submitting === "link" ? "Adding…" : "Add link"}
                </button>
              </div>
              <div className="field">
                <label htmlFor={`${base}-file`}>{`${label} document (up to 15 MB)`}</label>
                <input id={`${base}-file`} type="file" accept="application/pdf,image/*" disabled={busy} onChange={(event) => setFile(event.target.files?.[0] ?? null)} style={{ width: "100%" }} />
              </div>
              <div>
                <button type="button" className="btn" onClick={uploadFile} disabled={busy || !file} style={busy || !file ? DISABLED_BUTTON_STYLE : undefined}>
                  {submitting === "file" ? "Uploading…" : "Upload document"}
                </button>
              </div>
            </>
          )}
        </Option>

        <Option number={4} title={`Enter the details on the ${noun} record`}>
          <small className="muted">{`Opens the ${noun} record in a new tab, where the ${label} details can be entered.`}</small>
          <div>
            <a className="btn" href={owningRecordHref(counterparty.type, counterparty.ref)} target="_blank" rel="noopener noreferrer">
              {`Open the ${noun} record`}
            </a>
          </div>
        </Option>
      </div>

      {error && (
        <div className="banner" role="alert" style={{ marginTop: 14 }}>
          <span>
            <b>Couldn&rsquo;t add that.</b> {error}
          </span>
        </div>
      )}
    </DialogShell>
  );
}
