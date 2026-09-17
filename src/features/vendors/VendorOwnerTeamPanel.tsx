"use client";

import { useState } from "react";

import { Field, Fields } from "@/ui/Form";
import type { VendorDto } from "@/server/vendors/client-dto";
import type { VendorOwnerCandidateDto } from "@/server/vendors/user-picker";
import { setVendorOwnerTeam } from "./api-client";
import { VendorOwnerPicker } from "./VendorOwnerPicker";

// Owner/team assignment is a distinct authorized path
// (manage_vendor_ownership) from the ordinary profile edit - its own
// small panel/form, never folded into the ordinary edit PATCH. Mirrors
// Partners' own PartnerOwnerTeamPanel exactly.
export function VendorOwnerTeamPanel({ vendor, onSaved }: { vendor: VendorDto; onSaved: (vendor: VendorDto) => void }) {
  const [editing, setEditing] = useState(false);
  const [owner, setOwner] = useState<VendorOwnerCandidateDto | null>(vendor.ownerRef ? { userRef: vendor.ownerRef, displayName: vendor.ownerDisplayName ?? "Current owner", email: "" } : null);
  const [teams, setTeams] = useState(vendor.teamIds.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const result = await setVendorOwnerTeam(vendor.vendorRef, {
      ownerUserRef: owner?.userRef ?? null,
      teamIds: teams
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      expectedVersion: vendor.version,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setEditing(false);
    onSaved(result.data);
  }

  if (!editing) {
    return (
      <div className="kv">
        <span>Owner / team</span>
        <span>
          {vendor.ownerDisplayName ?? "Unassigned"}
          {vendor.teamIds.length > 0 ? ` · ${vendor.teamIds.join(", ")}` : ""}
          <button type="button" className="btn" style={{ marginLeft: 10 }} onClick={() => setEditing(true)}>
            Change
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className="field full">
      <Fields>
        <Field label="Owner">
          {owner ? (
            <div className="banner" role="status">
              <b>{owner.displayName}</b>
              <button type="button" className="btn" style={{ marginLeft: 10 }} onClick={() => setOwner(null)}>
                Clear
              </button>
            </div>
          ) : (
            <VendorOwnerPicker onSelect={setOwner} />
          )}
        </Field>
        <Field label="Teams">
          <input type="text" value={teams} onChange={(e) => setTeams(e.target.value)} />
        </Field>
      </Fields>
      {error && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
      <div className="actions" style={{ marginTop: 10 }}>
        <button type="button" className="btn" onClick={() => setEditing(false)} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save owner/team"}
        </button>
      </div>
    </div>
  );
}
