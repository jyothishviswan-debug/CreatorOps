"use client";

import { useId, useRef, useState, type ReactNode } from "react";

import { DialogShell } from "@/ui/Dialog";

import { addKycLinkEvidence, uploadKycEvidenceFile } from "../api-client";
import { DISABLED_BUTTON_STYLE, KYC_COMPONENT_LABELS, counterpartyTypeLabel, type KycComponentKey } from "../format";
import { useIntake } from "./intake-context";
import { BANK_NOT_FROM_CONTRACT, KYC_APPLY_FIELD, KYC_DOC_TYPES, evaluateApplyOption, extractionHasIdentityValue, kycDialogIntro, kycDialogTitle, owningRecordHref, validateEvidenceFile, validateEvidenceLink, type KycDialogKind } from "./kyc-ui";
import { readIdentityRecordVersion } from "./owning-versions";

// Step 14B intake (14B.1: component-scoped): `Upload / Update` for ONE component that is MISSING or INCOMPLETE. It is opened for that component only,
// and offers ONLY the canonical owning-module paths - Finance keeps no KYC copy of its own:
//   (a) apply the value found in the Agreement for THAT component (the Step 14A command with components:[that one], through the owning module;
//       bank details can never be applied from a contract and the dialog says so);
//   (b) add an evidence link or upload a document of THAT component's type through the Partner / Vendor evidence endpoints;
//   (c) open the Partner / Vendor record to enter the details by hand.
// After any success the KYC status (and the cross-verification, which compares the identity status) is read again through the intake context.
const NO_RECORD_MESSAGE = "There is no KYC record for this Partner or Vendor yet, so evidence cannot be added. Enter the details on the Partner / Vendor record first (option 3).";

function Option({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <section style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, display: "grid", gap: 8, minWidth: 0 }} aria-label={`Option ${number}: ${title}`}>
      <b style={{ fontSize: 12 }}>{`${number}. ${title}`}</b>
      {children}
    </section>
  );
}

export function KycDialog({ component, kind, onClose }: { component: KycComponentKey; kind: KycDialogKind; onClose: () => void }) {
  const intake = useIntake();
  const { counterparty, flags, permissions, extraction, extractionAttached, getField } = intake;
  const base = useId();
  const [link, setLink] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<null | "apply" | "link" | "file">(null);
  const guard = useRef(false);

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
    // The dialog is only opened for a MISSING or INCOMPLETE component: the canonical value is empty either way.
    componentMissing: true,
  });

  const close = () => {
    if (guard.current) return;
    onClose();
  };

  const run = async (kind: "apply" | "link" | "file", work: () => Promise<{ ok: boolean; message?: string; aborted?: boolean }>) => {
    if (guard.current) return;
    guard.current = true;
    setSubmitting(kind);
    setError(null);
    try {
      const outcome = await work();
      if (outcome.ok) {
        void intake.refreshKyc();
        // The comparison includes the identity status: refresh it only when it was already loaded (never start one from here).
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
        <button type="button" className="btn" onClick={close} disabled={submitting !== null} style={submitting !== null ? DISABLED_BUTTON_STYLE : undefined}>
          Close
        </button>
      }
    >
      <p className="detailcopy">{kycDialogIntro(component, kind, counterparty.type)}</p>

      <div style={{ display: "grid", gap: 12 }}>
        <Option number={1} title="Apply KYC values found in the Agreement">
          {component === "bank" ? (
            <small className="muted">{BANK_NOT_FROM_CONTRACT}</small>
          ) : (
            <>
              <small className="muted">{`Fills the empty ${label} in the ${noun} record with the value found in the Agreement. It is written through the ${noun} record's own rules.`}</small>
              {!apply.available && (
                <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 11 }}>
                  {apply.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
              <div>
                <button type="button" className="btn" onClick={() => void applyFromAgreement()} disabled={busy || !apply.available} aria-disabled={busy || !apply.available} style={busy || !apply.available ? DISABLED_BUTTON_STYLE : undefined}>
                  {submitting === "apply" ? "Applying…" : "Apply from Agreement"}
                </button>
              </div>
            </>
          )}
        </Option>

        <Option number={2} title="Add a document link or upload a document">
          {vendorAadhaar ? (
            <small className="muted">Aadhaar applies to Partners only.</small>
          ) : (
            <>
              <small className="muted">{`The document is added to the ${noun} record's own evidence. If storing it fails, the reason is shown here and nothing is recorded.`}</small>
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
                <button type="button" className="btn" onClick={uploadFile} disabled={busy || !file} aria-disabled={busy || !file} style={busy || !file ? DISABLED_BUTTON_STYLE : undefined}>
                  {submitting === "file" ? "Uploading…" : "Upload document"}
                </button>
              </div>
            </>
          )}
        </Option>

        <Option number={3} title={`Enter the details on the ${noun} record`}>
          <small className="muted">{`Opens the ${noun} record in a new tab, where the ${label} details can be entered. Come back and refresh the KYC status afterwards.`}</small>
          <div>
            <a className="btn" href={owningRecordHref(counterparty.type, counterparty.ref)} target="_blank" rel="noopener noreferrer">
              {`Open the ${noun} record`}
            </a>
          </div>
        </Option>
      </div>

      <div aria-live="polite">
        {error && (
          <div className="banner" role="alert" style={{ marginTop: 14, marginBottom: 0 }}>
            <span>
              <b>Couldn’t add that.</b> {error}
            </span>
          </div>
        )}
      </div>
    </DialogShell>
  );
}
