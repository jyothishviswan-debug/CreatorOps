"use client";

import { useState } from "react";

import { Field, Fields } from "@/ui/Form";
import type { PartnerDto } from "@/server/partners/client-dto";
import type { PartnerOwnerCandidateDto } from "@/server/partners/user-picker";
import { setPartnerOwnerTeam } from "./api-client";
import { PartnerOwnerPicker } from "./PartnerOwnerPicker";

// Owner/team assignment is a distinct authorized path (manage_partner_ownership)
// from the ordinary profile edit (Step 7B section 4: "Owner/team changes
// must use the real authorized path and must not bypass scope rules") -
// its own small panel/form, never folded into PartnerForm's PATCH body.
export function PartnerOwnerTeamPanel({ partner, onSaved }: { partner: PartnerDto; onSaved: (partner: PartnerDto) => void }) {
  const [editing, setEditing] = useState(false);
  const [owner, setOwner] = useState<PartnerOwnerCandidateDto | null>(partner.ownerRef ? { userRef: partner.ownerRef, displayName: partner.ownerDisplayName ?? "Current owner", email: "" } : null);
  const [teams, setTeams] = useState(partner.teamIds.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const result = await setPartnerOwnerTeam(partner.partnerRef, {
      ownerUserRef: owner?.userRef ?? null,
      teamIds: teams
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      expectedVersion: partner.version,
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
          {partner.ownerDisplayName ?? "Unassigned"}
          {partner.teamIds.length > 0 ? ` · ${partner.teamIds.join(", ")}` : ""}
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
        <Field label="Owner" hint="Search active users by email.">
          {owner ? (
            <div className="banner" role="status">
              <b>{owner.displayName}</b>
              <button type="button" className="btn" style={{ marginLeft: 10 }} onClick={() => setOwner(null)}>
                Clear
              </button>
            </div>
          ) : (
            <PartnerOwnerPicker onSelect={setOwner} />
          )}
        </Field>
        <Field label="Teams" hint="Comma-separated.">
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
