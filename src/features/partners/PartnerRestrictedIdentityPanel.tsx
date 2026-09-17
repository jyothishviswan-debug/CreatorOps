"use client";

import { useState, type FormEvent } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { getPartnerRestrictedIdentity, savePartnerRestrictedIdentity } from "./api-client";

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
  const [existingVersion, setExistingVersion] = useState(0);
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
      setExistingVersion(result.data.version);
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
            <p className="foundationnote">No postal address or address proof is collected. These values are never shown outside this authorized panel.</p>
            <div className="fields">
              <div className="field">
                <label htmlFor="ri-pan">PAN</label>
                <input id="ri-pan" type="text" value={panNumber} onChange={(e) => setPanNumber(e.target.value)} />
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
      </PanelBody>
    </Panel>
  );
}
