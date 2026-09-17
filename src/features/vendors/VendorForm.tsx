"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { FormLayout, FormSection, Fields, Field, FormFoot, Checklist } from "@/ui/Form";
import { Icon } from "@/ui/icons";
import { RegionMultiSelect } from "@/features/shared/RegionMultiSelect";
import type { VendorOwnerCandidateDto } from "@/server/vendors/user-picker";
import { VENDOR_TYPES, type VendorDuplicateCheckResult, type VendorType } from "@/server/vendors/types";
import { createVendor, precheckVendorDuplicates } from "./api-client";
import { DuplicateStatusBanner } from "./DuplicateStatus";
import { VendorOwnerPicker } from "./VendorOwnerPicker";
import { VENDOR_TYPE_LABELS } from "./format";

function fromCsv(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

// Step 8B section 3: direct Vendor creation over the real trusted
// service. Only canonical ordinary fields - no PAN/GST/bank here (that
// belongs exclusively in the Restricted Identity tab, after creation).
// Mirrors Partners' own PartnerForm (create mode) closely.
export function VendorForm() {
  const router = useRouter();

  const [displayName, setDisplayName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [vendorType, setVendorType] = useState<VendorType>("AGENCY");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [regions, setRegions] = useState<string[]>([]);
  const [websiteLabel, setWebsiteLabel] = useState("Website");
  const [websiteValue, setWebsiteValue] = useState("");
  const [teams, setTeams] = useState("");

  const [owner, setOwner] = useState<VendorOwnerCandidateDto | null>(null);

  const [duplicateResult, setDuplicateResult] = useState<VendorDuplicateCheckResult | null>(null);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const hasIdentitySignal = Boolean(displayName.trim() || email.trim() || phone.trim());
  useEffect(() => {
    if (!hasIdentitySignal) return;
    let cancelled = false;
    const timeout = setTimeout(async () => {
      setCheckingDuplicates(true);
      const result = await precheckVendorDuplicates({
        displayName: displayName.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
      });
      if (cancelled) return;
      setCheckingDuplicates(false);
      setDuplicateResult(result.ok ? result.data : { status: "unknown", matches: [], checkedAt: new Date().toISOString() });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [displayName, email, phone, hasIdentitySignal]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);

    const result = await createVendor({
      displayName,
      legalName: legalName.trim() || undefined,
      vendorType,
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
      businessReferences: websiteValue.trim() ? [{ label: websiteLabel.trim() || "Website", value: websiteValue.trim() }] : undefined,
      regionIds: regions,
      teamIds: fromCsv(teams),
      ownerUserRef: owner?.userRef,
    });
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.error);
      return;
    }
    router.push(`/vendors/${result.data.vendorRef}`);
    router.refresh();
  }

  return (
    <FormLayout>
      <form className="panel" onSubmit={handleSubmit}>
        <FormSection title="Business essentials" description="Use canonical identifiers to keep the programme free of duplicates.">
          <Fields>
            <Field label="Business name">
              <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={200} placeholder="Creator House" />
            </Field>
            <Field label="Legal name">
              <input type="text" value={legalName} onChange={(e) => setLegalName(e.target.value)} maxLength={200} />
            </Field>
            <Field label="Vendor type">
              <select value={vendorType} onChange={(e) => setVendorType(e.target.value as VendorType)}>
                {VENDOR_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {VENDOR_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Email address">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Phone number">
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Field label="Teams">
              <input type="text" value={teams} onChange={(e) => setTeams(e.target.value)} placeholder="south-programmes" />
            </Field>
          </Fields>

          <Field label="Regions" full>
            <RegionMultiSelect value={regions} onChange={setRegions} />
          </Field>

          <Field label="Owner" full>
            {owner ? (
              <div className="banner" role="status">
                <b>{owner.displayName}</b> · {owner.email}
                <button type="button" className="btn" style={{ marginLeft: 10 }} onClick={() => setOwner(null)}>
                  Clear
                </button>
              </div>
            ) : (
              <VendorOwnerPicker onSelect={setOwner} />
            )}
          </Field>

          <DuplicateStatusBanner result={hasIdentitySignal ? duplicateResult : null} checking={hasIdentitySignal && checkingDuplicates} />
        </FormSection>

        <FormSection title="Business reference" description="An optional ordinary business link (e.g. a website) - never a restricted identifier.">
          <Fields>
            <Field label="Label">
              <input type="text" value={websiteLabel} onChange={(e) => setWebsiteLabel(e.target.value)} maxLength={80} />
            </Field>
            <Field label="Value">
              <input type="text" value={websiteValue} onChange={(e) => setWebsiteValue(e.target.value)} placeholder="https://example.com" maxLength={300} />
            </Field>
          </Fields>
        </FormSection>

        {saveError && (
          <div className="banner" role="alert" style={{ margin: "0 22px 18px" }}>
            <b>Couldn&rsquo;t save.</b> {saveError}
          </div>
        )}

        <FormFoot>
          <small>Creates a real Vendor</small>
          <div className="actions">
            <Link href="/vendors" className="btn">
              Cancel
            </Link>
            <button type="submit" className="btn primary" disabled={saving || !displayName.trim()}>
              {saving ? "Saving…" : "Create vendor"}
            </button>
          </div>
        </FormFoot>
      </form>

      <aside className="panel">
        <div className="panelhead">
          <h2>A cleaner first step</h2>
        </div>
        <div className="panelbody">
          <Checklist>
            <li>
              <Icon name="check" /> Capture business identity
            </li>
            <li>
              <Icon name="check" /> Real bounded duplicate checks
            </li>
            <li>
              <Icon name="check" /> No PAN/GST/bank collected here
            </li>
            <li>
              <Icon name="check" /> Relationships and restricted identity captured from the detail page
            </li>
          </Checklist>
          <div className="scopebox">Partner relationships, lifecycle, and restricted identity are recorded from the Vendor&rsquo;s own detail page.</div>
        </div>
      </aside>
    </FormLayout>
  );
}
