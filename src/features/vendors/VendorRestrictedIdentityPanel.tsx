"use client";

import { useState, type FormEvent } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { getVendorRestrictedIdentity, saveVendorRestrictedIdentity } from "./api-client";

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
  const [existingVersion, setExistingVersion] = useState(0);
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
    const result = await saveVendorRestrictedIdentity(vendorRef, {
      pan: panNumber.trim() ? { number: panNumber.trim() } : null,
      bank: accountNumber.trim() ? { accountHolderName, accountNumber, ifsc, bankName, branchName } : null,
      gst: { applicable: gstApplicable, number: gstApplicable ? gstNumber.trim() : undefined },
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
            <p className="foundationnote">Business subject fields only - no Aadhaar, no postal address. These values are never shown outside this authorized panel.</p>
            <div className="fields">
              <div className="field">
                <label htmlFor="vri-pan">PAN / tax ID</label>
                <input id="vri-pan" type="text" value={panNumber} onChange={(e) => setPanNumber(e.target.value)} />
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
      </PanelBody>
    </Panel>
  );
}
