"use client";

import { useState, type FormEvent } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import type { RestrictedFinancialIdentityEvidence } from "@/server/shared/restricted-financial-identity";
import { addVendorRestrictedIdentityLinkEvidence, getVendorRestrictedIdentity, saveVendorRestrictedIdentity, uploadVendorRestrictedIdentityEvidence } from "./api-client";

// Restricted financial/tax identity - gated by BOTH the
// manage_vendor_restricted_identity action AND the vendor_payment_details
// sensitive category (see vendors-gate.ts). Never fetched merely to hide
// it in the browser - stays "idle" (a button, no request) until the
// operator explicitly asks to view/manage it. Mirrors Partners' own
// PartnerRestrictedIdentityPanel, deliberately WITHOUT an Aadhaar field
// (Vendor is a business subject, not a Partner/individual one) and using
// the Vendor-specific trusted endpoint/collection discriminator.
export function VendorRestrictedIdentityPanel({ vendorRef }: { vendorRef: string }) {
  const [state, setState] = useState<"idle" | "loading" | "denied" | "error" | "ready">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [panNumber, setPanNumber] = useState("");
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
    const result = await getVendorRestrictedIdentity(vendorRef);
    if (!result.ok) {
      setState(result.code === "unauthorized" ? "denied" : "error");
      setErrorMessage(result.error);
      return;
    }
    setState("ready");
    if (result.data) {
      setPanNumber(result.data.pan?.number ?? "");
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
    const result = await saveVendorRestrictedIdentity(vendorRef, {
      pan: panNumber.trim() ? { number: panNumber.trim() } : null,
      bank: accountNumber.trim() ? { accountHolderName, accountNumber, ifsc, bankName, branchName } : null,
      gst: { applicable: gstApplicable, number: gstApplicable ? gstNumber.trim() : undefined },
      address: address.trim() ? address.trim() : null,
      expectedVersion: existingVersion,
    });
    setSaving(false);
    if (!result.ok) {
      // Same-GST collision surfaces as an ordinary 409 "conflict" - shown
      // inline, distinct from a stale-version conflict only by its
      // message text (the server never exposes which other Vendor holds
      // the number).
      setSaveError(result.error);
      return;
    }
    setExistingVersion(result.data.version);
  }

  return (
    <Panel span={12}>
      <PanelHead title="Restricted identity" description="Gated by the vendor_payment_details sensitive-access category. Never included in the ordinary Vendor DTO or history." />
      <PanelBody>
        {state === "idle" && (
          <button type="button" className="btn" onClick={load}>
            View / manage restricted identity
          </button>
        )}
        {state === "loading" && <p className="foundationnote">Loading…</p>}
        {state === "denied" && (
          <div className="banner" role="alert">
            <b>Restricted.</b> {errorMessage ?? "This requires the vendor_payment_details sensitive-access category."}
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
            <p className="foundationnote">Business subject fields only - no Aadhaar. These values are never shown outside this authorized panel.</p>
            <div className="fields">
              <div className="field">
                <label htmlFor="vri-pan">PAN / tax ID</label>
                <input id="vri-pan" type="text" value={panNumber} onChange={(e) => setPanNumber(e.target.value)} />
              </div>
              <div className="field full">
                <label htmlFor="vri-address">Registered / billing address</label>
                <textarea id="vri-address" rows={3} maxLength={500} value={address} onChange={(e) => setAddress(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="vri-account-holder">Account holder name</label>
                <input id="vri-account-holder" type="text" value={accountHolderName} onChange={(e) => setAccountHolderName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="vri-account-number">Account number</label>
                <input id="vri-account-number" type="text" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="vri-ifsc">IFSC</label>
                <input id="vri-ifsc" type="text" value={ifsc} onChange={(e) => setIfsc(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="vri-bank-name">Bank name</label>
                <input id="vri-bank-name" type="text" value={bankName} onChange={(e) => setBankName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="vri-branch-name">Branch name</label>
                <input id="vri-branch-name" type="text" value={branchName} onChange={(e) => setBranchName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="vri-gst-applicable">
                  <input id="vri-gst-applicable" type="checkbox" checked={gstApplicable} onChange={(e) => setGstApplicable(e.target.checked)} style={{ marginRight: 8 }} />
                  GST applicable
                </label>
              </div>
              {gstApplicable && (
                <div className="field">
                  <label htmlFor="vri-gst-number">GST number</label>
                  <input id="vri-gst-number" type="text" value={gstNumber} onChange={(e) => setGstNumber(e.target.value)} required />
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
          <EvidenceManager vendorRef={vendorRef} version={existingVersion} evidence={evidence} onChanged={(version, next) => { setExistingVersion(version); setEvidence(next); }} />
        )}
      </PanelBody>
    </Panel>
  );
}

// No Aadhaar for a Vendor (a business subject, not an individual) - same
// rule VendorRestrictedIdentityPanel's own form above already follows,
// and the same set addVendorRestrictedIdentityLinkEvidence's own input
// schema accepts server-side. The label map stays the full shared union
// (defensive display only, never offered as a choice) - DOC_TYPES, the
// actual picker options, is what enforces the Vendor-specific set.
type VendorEvidenceDocType = Exclude<RestrictedFinancialIdentityEvidence["docType"], "aadhaar">;
const DOC_TYPE_LABELS: Record<RestrictedFinancialIdentityEvidence["docType"], string> = {
  pan: "PAN",
  aadhaar: "Aadhaar",
  gst: "GST certificate",
  bank: "Bank proof",
  other: "Other",
};
const DOC_TYPES: VendorEvidenceDocType[] = ["pan", "gst", "bank", "other"];

// A supplementary evidence manager, additional to (never a replacement
// for) the plain restricted fields above. One document at a time: pick
// its type, choose link or upload, submit - real uploads land in this
// Vendor's own Drive subfolder (named "V{sequenceNumber}_{displayName}_",
// allocated on first upload) and only the real Drive link Drive returns
// is ever stored. Mirrors Discovery's own KycAttachments exactly.
function EvidenceManager({
  vendorRef,
  version,
  evidence,
  onChanged,
}: {
  vendorRef: string;
  version: number;
  evidence: RestrictedFinancialIdentityEvidence[];
  onChanged: (version: number, evidence: RestrictedFinancialIdentityEvidence[]) => void;
}) {
  const [docType, setDocType] = useState<VendorEvidenceDocType>("pan");
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
      const result = await addVendorRestrictedIdentityLinkEvidence(vendorRef, { docType, url: linkUrl.trim(), expectedVersion: version });
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
    const result = await uploadVendorRestrictedIdentityEvidence(vendorRef, { docType, file, expectedVersion: version });
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
      <p className="foundationnote">Add a link to an existing document, or upload a real file - uploads are stored in this Vendor&rsquo;s own Drive folder, never simulated.</p>

      <form onSubmit={handleAdd}>
        <div className="fields">
          <div className="field">
            <label htmlFor="vri-evidence-doc-type">Document name</label>
            <select id="vri-evidence-doc-type" value={docType} onChange={(e) => setDocType(e.target.value as VendorEvidenceDocType)}>
              {DOC_TYPES.map((type) => (
                <option key={type} value={type}>
                  {DOC_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="vri-evidence-mode">Source</label>
            <select id="vri-evidence-mode" value={mode} onChange={(e) => setMode(e.target.value as "link" | "upload")}>
              <option value="link">Doc link</option>
              <option value="upload">Upload file</option>
            </select>
          </div>
          {mode === "link" ? (
            <div className="field full" key="link">
              <label htmlFor="vri-evidence-url">Document link</label>
              <input id="vri-evidence-url" type="url" placeholder="https://…" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} required />
            </div>
          ) : (
            <div className="field full" key="upload">
              <label htmlFor="vri-evidence-file">Choose file</label>
              <input id="vri-evidence-file" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
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
