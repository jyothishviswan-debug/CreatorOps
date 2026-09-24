"use client";

import { useState, type FormEvent } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import type { RestrictedFinancialIdentityEvidence } from "@/server/shared/restricted-financial-identity";
import { addPartnerRestrictedIdentityLinkEvidence, getPartnerRestrictedIdentity, savePartnerRestrictedIdentity, uploadPartnerRestrictedIdentityEvidence } from "./api-client";

// Restricted financial/KYC identity - gated by BOTH the
// manage_partner_restricted_identity action AND the payment_details
// sensitive category (see partners-gate.ts). Never fetched merely to
// hide it in the browser - stays "idle" (a button, no request) until the
// operator explicitly asks to view/manage it, same idiom as Discovery's
// own restricted KYC panel.
export function PartnerRestrictedIdentityPanel({ partnerRef }: { partnerRef: string }) {
  const [state, setState] = useState<"idle" | "loading" | "denied" | "error" | "ready">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [panNumber, setPanNumber] = useState("");
  const [aadhaarNumber, setAadhaarNumber] = useState("");
  const [accountHolderName, setAccountHolderName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [bankName, setBankName] = useState("");
  const [branchName, setBranchName] = useState("");
  const [gstApplicable, setGstApplicable] = useState(false);
  const [gstNumber, setGstNumber] = useState("");
  const [address, setAddress] = useState("");
  const [existingVersion, setExistingVersion] = useState(0);
  const [evidence, setEvidence] = useState<RestrictedFinancialIdentityEvidence[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function load() {
    setState("loading");
    setErrorMessage(null);
    const result = await getPartnerRestrictedIdentity(partnerRef);
    if (!result.ok) {
      setState(result.code === "unauthorized" ? "denied" : "error");
      setErrorMessage(result.error);
      return;
    }
    setState("ready");
    if (result.data) {
      setPanNumber(result.data.pan?.number ?? "");
      setAadhaarNumber(result.data.aadhaar?.number ?? "");
      setAccountHolderName(result.data.bank?.accountHolderName ?? "");
      setAccountNumber(result.data.bank?.accountNumber ?? "");
      setIfsc(result.data.bank?.ifsc ?? "");
      setBankName(result.data.bank?.bankName ?? "");
      setBranchName(result.data.bank?.branchName ?? "");
      setGstApplicable(result.data.gst?.applicable ?? false);
      setGstNumber(result.data.gst?.number ?? "");
      setAddress(result.data.address ?? "");
      setExistingVersion(result.data.version);
      setEvidence(result.data.evidence);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (gstApplicable && !gstNumber.trim()) {
      setSaveError("GST number is required when GST is applicable.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    const result = await savePartnerRestrictedIdentity(partnerRef, {
      pan: panNumber.trim() ? { number: panNumber.trim() } : null,
      aadhaar: aadhaarNumber.trim() ? { number: aadhaarNumber.trim() } : null,
      bank: accountNumber.trim() ? { accountHolderName, accountNumber, ifsc, bankName, branchName } : null,
      gst: { applicable: gstApplicable, number: gstApplicable ? gstNumber.trim() : undefined },
      address: address.trim() ? address.trim() : null,
      expectedVersion: existingVersion,
    });
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.error);
      return;
    }
    setExistingVersion(result.data.version);
  }

  return (
    <Panel span={12}>
      <PanelHead title="Restricted identity" description="Gated by the payment_details sensitive-access category. Never included in the ordinary Partner DTO or history." />
      <PanelBody>
        {state === "idle" && (
          <button type="button" className="btn" onClick={load}>
            View / manage restricted identity
          </button>
        )}
        {state === "loading" && <p className="foundationnote">Loading…</p>}
        {state === "denied" && (
          <div className="banner" role="alert">
            <b>Restricted.</b> {errorMessage ?? "This requires the payment_details sensitive-access category."}
          </div>
        )}
        {state === "error" && (
          <div className="banner" role="alert">
            <b>Couldn&rsquo;t load restricted identity.</b> {errorMessage}
            <button type="button" className="btn" style={{ marginLeft: 10 }} onClick={load}>
              Retry
            </button>
          </div>
        )}
        {state === "ready" && (
          <form onSubmit={handleSubmit}>
            <p className="foundationnote">These values are never shown outside this authorized panel.</p>
            <div className="fields">
              <div className="field">
                <label htmlFor="ri-pan">PAN</label>
                <input id="ri-pan" type="text" value={panNumber} onChange={(e) => setPanNumber(e.target.value)} />
              </div>
              <div className="field full">
                <label htmlFor="ri-address">Registered / billing address</label>
                <textarea id="ri-address" rows={3} maxLength={500} value={address} onChange={(e) => setAddress(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="ri-aadhaar">Aadhaar number</label>
                <input id="ri-aadhaar" type="text" value={aadhaarNumber} onChange={(e) => setAadhaarNumber(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="ri-account-holder">Account holder name</label>
                <input id="ri-account-holder" type="text" value={accountHolderName} onChange={(e) => setAccountHolderName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="ri-account-number">Account number</label>
                <input id="ri-account-number" type="text" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="ri-ifsc">IFSC</label>
                <input id="ri-ifsc" type="text" value={ifsc} onChange={(e) => setIfsc(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="ri-bank-name">Bank name</label>
                <input id="ri-bank-name" type="text" value={bankName} onChange={(e) => setBankName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="ri-branch-name">Branch name</label>
                <input id="ri-branch-name" type="text" value={branchName} onChange={(e) => setBranchName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="ri-gst-applicable">
                  <input id="ri-gst-applicable" type="checkbox" checked={gstApplicable} onChange={(e) => setGstApplicable(e.target.checked)} style={{ marginRight: 8 }} />
                  GST applicable
                </label>
              </div>
              {gstApplicable && (
                <div className="field">
                  <label htmlFor="ri-gst-number">GST number</label>
                  <input id="ri-gst-number" type="text" value={gstNumber} onChange={(e) => setGstNumber(e.target.value)} required />
                </div>
              )}
            </div>

            {saveError && (
              <div className="banner" role="alert" style={{ marginTop: 10 }}>
                {saveError}
              </div>
            )}

            <div className="actions" style={{ marginTop: 12 }}>
              <button type="submit" className="btn primary" disabled={saving}>
                {saving ? "Saving…" : "Save restricted identity"}
              </button>
            </div>
          </form>
        )}
        {state === "ready" && existingVersion > 0 && (
          <EvidenceManager partnerRef={partnerRef} version={existingVersion} evidence={evidence} onChanged={(version, next) => { setExistingVersion(version); setEvidence(next); }} />
        )}
      </PanelBody>
    </Panel>
  );
}

const DOC_TYPE_LABELS: Record<RestrictedFinancialIdentityEvidence["docType"], string> = {
  pan: "PAN",
  aadhaar: "Aadhaar",
  gst: "GST certificate",
  bank: "Bank proof",
  other: "Other",
};
const DOC_TYPES = Object.keys(DOC_TYPE_LABELS) as RestrictedFinancialIdentityEvidence["docType"][];

// A supplementary evidence manager, additional to (never a replacement
// for) the plain restricted fields above. One document at a time: pick
// its type, choose link or upload, submit - real uploads land in this
// Partner's own Drive subfolder (named "P{sequenceNumber}_{displayName}_",
// allocated on first upload) and only the real Drive link Drive returns
// is ever stored. Mirrors Discovery's own KycAttachments exactly.
function EvidenceManager({
  partnerRef,
  version,
  evidence,
  onChanged,
}: {
  partnerRef: string;
  version: number;
  evidence: RestrictedFinancialIdentityEvidence[];
  onChanged: (version: number, evidence: RestrictedFinancialIdentityEvidence[]) => void;
}) {
  const [docType, setDocType] = useState<RestrictedFinancialIdentityEvidence["docType"]>("aadhaar");
  const [mode, setMode] = useState<"link" | "upload">("link");
  const [linkUrl, setLinkUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (mode === "link") {
      if (!linkUrl.trim()) return;
      setBusy(true);
      const result = await addPartnerRestrictedIdentityLinkEvidence(partnerRef, { docType, url: linkUrl.trim(), expectedVersion: version });
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLinkUrl("");
      onChanged(result.data.version, [...evidence, result.data.evidence]);
      return;
    }

    if (!file) return;
    setBusy(true);
    const result = await uploadPartnerRestrictedIdentityEvidence(partnerRef, { docType, file, expectedVersion: version });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setFile(null);
    onChanged(result.data.version, [...evidence, result.data.evidence]);
  }

  return (
    <div style={{ marginTop: 28 }}>
      <h3>Document evidence</h3>
      <p className="foundationnote">Add a link to an existing document, or upload a real file - uploads are stored in this Partner&rsquo;s own Drive folder, never simulated.</p>

      <form onSubmit={handleAdd}>
        <div className="fields">
          <div className="field">
            <label htmlFor="ri-evidence-doc-type">Document name</label>
            <select id="ri-evidence-doc-type" value={docType} onChange={(e) => setDocType(e.target.value as RestrictedFinancialIdentityEvidence["docType"])}>
              {DOC_TYPES.map((type) => (
                <option key={type} value={type}>
                  {DOC_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ri-evidence-mode">Source</label>
            <select id="ri-evidence-mode" value={mode} onChange={(e) => setMode(e.target.value as "link" | "upload")}>
              <option value="link">Doc link</option>
              <option value="upload">Upload file</option>
            </select>
          </div>
          {mode === "link" ? (
            <div className="field full" key="link">
              <label htmlFor="ri-evidence-url">Document link</label>
              <input id="ri-evidence-url" type="url" placeholder="https://…" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} required />
            </div>
          ) : (
            <div className="field full" key="upload">
              <label htmlFor="ri-evidence-file">Choose file</label>
              <input id="ri-evidence-file" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
            </div>
          )}
        </div>
        {error && (
          <div className="banner" role="alert" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
        <button type="submit" className="btn" disabled={busy} style={{ marginTop: 12 }}>
          {busy ? "Adding…" : mode === "link" ? "Add link" : "Upload"}
        </button>
      </form>

      {evidence.length > 0 && (
        <ul className="checklist" style={{ marginTop: 18, gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
          {evidence.map((e, i) => (
            <li key={`${e.docType}-${e.addedAt}-${i}`}>
              <b>{DOC_TYPE_LABELS[e.docType]}</b> ·{" "}
              <a href={e.url} target="_blank" rel="noreferrer">
                {e.kind === "upload" ? (e.fileName ?? "Uploaded file") : "Open link"}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
