"use client";

import { useState } from "react";

import type { LeadDto } from "@/server/discovery/client-dto";
import type { OwnerCandidateDto } from "@/server/discovery/user-picker";
import { assignOwner } from "./api-client";
import { OwnerPicker } from "./OwnerPicker";

// Finding #12/#13: Owner always has a value (defaults to the creating
// actor server-side, see lead-service.ts's createLead) - this panel is
// reassignment only, never a "clear" control, unlike Manager's own panel.
// Modeled on PartnerOwnerTeamPanel's editing-toggle shape, but fixes that
// pattern's own latent bug: Cancel here genuinely resets local state back
// to the confirmed value (not just the `editing` flag), so re-opening the
// picker after a cancel never shows a stale unsaved pick.
export function DiscoveryLeadOwnerPanel({ lead, onSaved }: { lead: LeadDto; onSaved: (lead: LeadDto) => void }) {
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<OwnerCandidateDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEditing() {
    setPending(null);
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setPending(null);
    setError(null);
    setEditing(false);
  }

  async function save() {
    if (!pending) return;
    setSaving(true);
    setError(null);
    const result = await assignOwner(lead.leadRef, { ownerUserRef: pending.userRef, expectedVersion: lead.version });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setEditing(false);
    setPending(null);
    onSaved(result.data);
  }

  if (!editing) {
    return (
      <div className="kv">
        <span>Owner</span>
        <span>
          {lead.ownerDisplayName ?? "Unassigned"}
          <button type="button" className="btn" style={{ marginLeft: 10 }} onClick={startEditing}>
            Change
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className="field full">
      <label>Owner</label>
      <small>Search active users by email.</small>
      {pending ? (
        <div className="banner" role="status" style={{ marginTop: 8 }}>
          <b>{pending.displayName}</b>
          <button type="button" className="btn" style={{ marginLeft: 10 }} onClick={() => setPending(null)}>
            Pick someone else
          </button>
        </div>
      ) : (
        <OwnerPicker onSelect={setPending} />
      )}
      {error && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
      <div className="actions" style={{ marginTop: 10 }}>
        <button type="button" className="btn" onClick={cancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={save} disabled={saving || !pending}>
          {saving ? "Saving…" : "Save owner"}
        </button>
      </div>
    </div>
  );
}
