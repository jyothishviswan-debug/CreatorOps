"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import { Icon } from "@/ui/icons";
import type { PartnerDto } from "@/server/partners/client-dto";
import type { VendorPartnerLinkWithPartnerDto } from "@/server/vendors/client-dto";
import { RELATIONSHIP_TYPES, type RelationshipType } from "@/server/vendors/types";
import { createVendorPartnerLink, editVendorPartnerLink, endVendorPartnerLink, listVendorPartnerLinks, restoreVendorPartnerLink } from "./api-client";
import { VendorPartnerPicker } from "./VendorPartnerPicker";
import { effectiveDateLabel, LINK_STATUS_LABELS, linkStatusTone, RELATIONSHIP_TYPE_LABELS, relativeTime } from "./format";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Step 8B section 6 - the core Vendor workflow: the real M:N
// vendorPartnerLinks list, scoped to this one Vendor. A Partner may have
// multiple Vendor relationships and a Vendor may represent multiple
// Partners - this list shows every relationship this Vendor has, active
// and historical, never collapsed into a single "owns" concept.
// relationshipType and payeeRole are edited independently, and ending a
// relationship never deletes the row (see endVendorPartnerLink's own
// comment) - the ended row stays visible here, tagged "Ended".
export function VendorRelationshipsPanel({ vendorRef }: { vendorRef: string }) {
  const [links, setLinks] = useState<VendorPartnerLinkWithPartnerDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editingRef, setEditingRef] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listVendorPartnerLinks(vendorRef).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setLinks(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [vendorRef, refreshKey]);

  function handleChanged() {
    setRefreshKey((k) => k + 1);
    setCreating(false);
    setEditingRef(null);
  }

  const activeCount = links.filter((l) => l.status === "ACTIVE").length;

  return (
    <Panel span={12}>
      <PanelHead
        title="Partner Relationships"
        description="Every Vendor <-> Partner relationship this Vendor has, active and historical - relationship type and payee role are always explicit, never inferred."
        link={
          !creating && (
            <button type="button" className="btn" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Link a Partner
            </button>
          )
        }
      />
      <PanelBody>
        {creating && <LinkForm mode="create" vendorRef={vendorRef} onSaved={handleChanged} onCancel={() => setCreating(false)} />}

        {loading ? (
          <Skeleton lines={3} />
        ) : error ? (
          <div className="banner" role="alert">
            {error}
          </div>
        ) : links.length === 0 && !creating ? (
          <EmptyState title="No Partner relationships yet" description="Link this Vendor to a real, scope-authorized Partner." icon="link" />
        ) : (
          <>
            {activeCount > 0 && (
              <p className="foundationnote" style={{ marginBottom: 10 }}>
                {activeCount} active relationship{activeCount === 1 ? "" : "s"} · {links.length} total on file.
              </p>
            )}
            {links.map((link) =>
              editingRef === link.vendorPartnerLinkRef ? (
                <LinkForm key={link.vendorPartnerLinkRef} mode="edit" link={link} onSaved={handleChanged} onCancel={() => setEditingRef(null)} />
              ) : (
                <LinkRow key={link.vendorPartnerLinkRef} link={link} onEdit={() => setEditingRef(link.vendorPartnerLinkRef)} onChanged={handleChanged} />
              ),
            )}
          </>
        )}
      </PanelBody>
    </Panel>
  );
}

function LinkRow({ link, onEdit, onChanged }: { link: VendorPartnerLinkWithPartnerDto; onEdit: () => void; onChanged: () => void }) {
  const [ending, setEnding] = useState(false);
  const [effectiveTo, setEffectiveTo] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmEnd() {
    setBusy(true);
    setError(null);
    const result = await endVendorPartnerLink(link.vendorPartnerLinkRef, { effectiveTo, expectedVersion: link.version });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onChanged();
  }

  async function restore() {
    setBusy(true);
    setError(null);
    const result = await restoreVendorPartnerLink(link.vendorPartnerLinkRef, { expectedVersion: link.version });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onChanged();
  }

  return (
    <div className="record" style={{ marginBottom: 10 }}>
      <div className="recordmeta" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <b>{link.partner.displayName}</b>
          <Pill tone={linkStatusTone(link.status)}> {LINK_STATUS_LABELS[link.status]}</Pill>
          <Pill tone="default"> {RELATIONSHIP_TYPE_LABELS[link.relationshipType]}</Pill>
          {link.payeeRole && <Pill tone="orange"> Payee</Pill>}
          <div>
            <small>
              Effective {effectiveDateLabel(link.effectiveFrom)}
              {link.effectiveTo ? ` – ${effectiveDateLabel(link.effectiveTo)}` : " – ongoing"}
            </small>
          </div>
          <div>
            <small>Last updated {relativeTime(link.updatedAt)}</small>
          </div>
        </div>
        <div className="actions">
          {link.status === "ACTIVE" ? (
            <>
              <button type="button" className="btn" onClick={onEdit}>
                Edit
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setEnding(true)}>
                End relationship
              </button>
            </>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={restore}>
              {busy ? "Restoring…" : "Restore"}
            </button>
          )}
        </div>
      </div>
      {ending && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          <b>End this relationship?</b> The row stays on file as historical - nothing is deleted.
          <div className="field" style={{ marginTop: 8, maxWidth: 220 }}>
            <label htmlFor={`end-date-${link.vendorPartnerLinkRef}`}>Effective end date</label>
            <input id={`end-date-${link.vendorPartnerLinkRef}`} type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} />
          </div>
          <div className="actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn" onClick={() => setEnding(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={confirmEnd}>
              {busy ? "Ending…" : "End relationship"}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </div>
  );
}

type LinkFormProps = { mode: "create"; vendorRef: string; onSaved: () => void; onCancel: () => void } | { mode: "edit"; link: VendorPartnerLinkWithPartnerDto; onSaved: () => void; onCancel: () => void };

function LinkForm(props: LinkFormProps) {
  const initial = props.mode === "edit" ? props.link : null;
  const [partner, setPartner] = useState<PartnerDto | null>(null);
  const [relationshipType, setRelationshipType] = useState<RelationshipType>(initial?.relationshipType ?? "REPRESENTATION");
  const [payeeRole, setPayeeRole] = useState(initial?.payeeRole ?? false);
  const [effectiveFrom, setEffectiveFrom] = useState(initial?.effectiveFrom ?? todayIso());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    if (props.mode === "create") {
      if (!partner) {
        setSaving(false);
        setError("Select a Partner to link.");
        return;
      }
      const result = await createVendorPartnerLink(props.vendorRef, { partnerRef: partner.partnerRef, relationshipType, payeeRole, effectiveFrom });
      setSaving(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      props.onSaved();
      return;
    }

    const result = await editVendorPartnerLink(props.link.vendorPartnerLinkRef, { relationshipType, payeeRole, effectiveFrom, expectedVersion: props.link.version });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    props.onSaved();
  }

  return (
    <form onSubmit={handleSubmit} className="record" style={{ marginBottom: 14 }}>
      {props.mode === "create" && (
        <div className="field full" style={{ marginBottom: 12 }}>
          <label>Partner</label>
          {partner ? (
            <div className="banner" role="status">
              <b>{partner.displayName}</b>
              <button type="button" className="btn" style={{ marginLeft: 10 }} onClick={() => setPartner(null)}>
                Change
              </button>
            </div>
          ) : (
            <VendorPartnerPicker onSelect={setPartner} />
          )}
        </div>
      )}
      {props.mode === "edit" && (
        <p className="foundationnote" style={{ marginBottom: 10 }}>
          Editing the relationship to <b>{props.link.partner.displayName}</b>. The linked Partner itself can&rsquo;t be changed - end this relationship and create a new one instead.
        </p>
      )}

      <div className="fields">
        <div className="field">
          <label>Relationship type</label>
          <select value={relationshipType} onChange={(e) => setRelationshipType(e.target.value as RelationshipType)}>
            {RELATIONSHIP_TYPES.map((t) => (
              <option key={t} value={t}>
                {RELATIONSHIP_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="link-effective-from">Effective from</label>
          <input id="link-effective-from" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required />
        </div>
        <div className="field">
          <label>
            <input type="checkbox" checked={payeeRole} onChange={(e) => setPayeeRole(e.target.checked)} style={{ marginRight: 8 }} />
            Payee role (explicit - independent of relationship type)
          </label>
        </div>
      </div>

      {error && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      <div className="actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn" onClick={props.onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={saving || (props.mode === "create" && !partner)}>
          {saving ? "Saving…" : props.mode === "create" ? "Link Partner" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
