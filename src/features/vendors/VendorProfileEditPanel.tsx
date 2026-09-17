"use client";

import { useState, type FormEvent } from "react";

import { Field, Fields } from "@/ui/Form";
import { RegionMultiSelect } from "@/features/shared/RegionMultiSelect";
import type { VendorDto } from "@/server/vendors/client-dto";
import { VENDOR_TYPES, type VendorType } from "@/server/vendors/types";
import { editVendor } from "./api-client";
import { VENDOR_TYPE_LABELS } from "./format";

// Ordinary profile editing, wired to the trusted versioned PATCH -
// editable ordinary fields only (never lifecycle, never owner/team,
// never restricted identity, never a Partner relationship - each of
// those has its own authorized path/panel). There is no dedicated
// `/vendors/[vendorId]/edit` route in the accepted skeleton, so this
// lives inline on the Overview tab as a toggleable panel, the same
// interaction shape Partners' own PartnerOwnerTeamPanel already
// establishes for a narrower field set.
export function VendorProfileEditPanel({ vendor, onSaved }: { vendor: VendorDto; onSaved: (vendor: VendorDto) => void }) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(vendor.displayName);
  const [legalName, setLegalName] = useState(vendor.legalName ?? "");
  const [vendorType, setVendorType] = useState<VendorType>(vendor.vendorType);
  const [email, setEmail] = useState(vendor.email ?? "");
  const [phone, setPhone] = useState(vendor.phone ?? "");
  const [regions, setRegions] = useState<string[]>(vendor.regionIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setStale(false);
    const result = await editVendor(vendor.vendorRef, {
      displayName,
      legalName: legalName.trim() || null,
      vendorType,
      email: email.trim() || null,
      phone: phone.trim() || null,
      regionIds: regions,
      expectedVersion: vendor.version,
    });
    setSaving(false);
    if (!result.ok) {
      if (result.code === "conflict") {
        setStale(true);
        return;
      }
      setError(result.error);
      return;
    }
    setEditing(false);
    onSaved(result.data);
  }

  if (!editing) {
    return (
      <button type="button" className="btn" onClick={() => setEditing(true)}>
        Edit profile
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="record" style={{ marginTop: 12 }}>
      {stale && (
        <div className="banner" role="alert" style={{ marginBottom: 14 }}>
          <b>This Vendor was changed elsewhere.</b> Reload before saving again.
          <button className="btn" type="button" onClick={() => window.location.reload()} style={{ marginLeft: 10 }}>
            Reload
          </button>
        </div>
      )}
      <Fields>
        <Field label="Business name">
          <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={200} />
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
      </Fields>
      <Field label="Regions" full>
        <RegionMultiSelect value={regions} onChange={setRegions} />
      </Field>

      {error && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      <div className="actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn" onClick={() => setEditing(false)} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={saving || !displayName.trim()}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
