"use client";

import { useState } from "react";

import { Field, Fields } from "@/ui/Form";
import type { CampaignDto } from "@/server/campaigns/client-dto";
import type { CampaignOwnerCandidateDto } from "@/server/campaigns/user-picker";
import { setCampaignOwnerTeam } from "./api-client";
import { CampaignOwnerPicker } from "./CampaignOwnerPicker";

// Owner/team assignment is a distinct authorized path
// (manage_campaign_ownership) from the ordinary plan edit - its own
// small panel/form, never folded into the ordinary edit PATCH. Mirrors
// Vendors'/Partners' own OwnerTeamPanel exactly. Owner is optional - an
// absent owner is never treated as an error here, only as an attention
// cue elsewhere (Overview/readiness).
export function CampaignOwnerTeamPanel({ campaign, onSaved }: { campaign: CampaignDto; onSaved: (campaign: CampaignDto) => void }) {
  const [editing, setEditing] = useState(false);
  const [owner, setOwner] = useState<CampaignOwnerCandidateDto | null>(campaign.ownerRef ? { userRef: campaign.ownerRef, displayName: campaign.ownerDisplayName ?? "Current owner", email: "" } : null);
  const [teams, setTeams] = useState(campaign.teamIds.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const result = await setCampaignOwnerTeam(campaign.campaignRef, {
      ownerUserRef: owner?.userRef ?? null,
      teamIds: teams
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      expectedVersion: campaign.version,
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
          {campaign.ownerDisplayName ?? "Unassigned"}
          {campaign.teamIds.length > 0 ? ` · ${campaign.teamIds.join(", ")}` : ""}
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
            <CampaignOwnerPicker onSelect={setOwner} />
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
