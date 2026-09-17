"use client";

import { useState, type FormEvent } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { EmptyState } from "@/ui/States";
import type { CampaignDto } from "@/server/campaigns/client-dto";
import { CAMPAIGN_RESOURCE_TYPES, type CampaignResource, type CampaignResourceType } from "@/server/campaigns/types";
import { addCampaignResource, editCampaignResource, removeCampaignResource } from "./api-client";
import { RESOURCE_TYPE_LABELS } from "./format";

// Real resource metadata only - never a document-upload system, never
// Agreement contract storage (Step 9B section 5's own explicit rule).
// Each mutation (add/edit/remove) uses its own dedicated endpoint and
// the Campaign's optimistic version, mirroring Vendors'/Partners' own
// relationship-panel idiom.
export function CampaignResourcesPanel({ campaign, onSaved }: { campaign: CampaignDto; onSaved: (campaign: CampaignDto) => void }) {
  const [creating, setCreating] = useState(false);
  const [editingRef, setEditingRef] = useState<string | null>(null);

  return (
    <Panel span={12}>
      <PanelHead
        title="Resources"
        description="Bounded ordinary resource metadata - labels, types, and safe URLs. No file upload, no restricted content."
        link={
          !creating && (
            <button type="button" className="btn" onClick={() => setCreating(true)}>
              + Add resource
            </button>
          )
        }
      />
      <PanelBody>
        {creating && (
          <ResourceForm mode="create" campaignRef={campaign.campaignRef} version={campaign.version} onSaved={(c) => { setCreating(false); onSaved(c); }} onCancel={() => setCreating(false)} />
        )}

        {campaign.resources.length === 0 && !creating ? (
          <EmptyState title="No resources yet" description="Add a link, document, brief, or other reference this Campaign's team needs." icon="brief" />
        ) : (
          campaign.resources.map((resource) =>
            editingRef === resource.resourceRef ? (
              <ResourceForm
                key={resource.resourceRef}
                mode="edit"
                campaignRef={campaign.campaignRef}
                version={campaign.version}
                resource={resource}
                onSaved={(c) => { setEditingRef(null); onSaved(c); }}
                onCancel={() => setEditingRef(null)}
              />
            ) : (
              <ResourceRow key={resource.resourceRef} campaignRef={campaign.campaignRef} version={campaign.version} resource={resource} onEdit={() => setEditingRef(resource.resourceRef)} onSaved={onSaved} />
            ),
          )
        )}
      </PanelBody>
    </Panel>
  );
}

function ResourceRow({
  campaignRef,
  version,
  resource,
  onEdit,
  onSaved,
}: {
  campaignRef: string;
  version: number;
  resource: CampaignResource;
  onEdit: () => void;
  onSaved: (campaign: CampaignDto) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    const result = await removeCampaignResource(campaignRef, { resourceRef: resource.resourceRef, expectedVersion: version });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved(result.data);
  }

  return (
    <div className="record" style={{ marginBottom: 10 }}>
      <div className="recordmeta" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <b>{resource.label}</b>
          <Pill tone="default"> {RESOURCE_TYPE_LABELS[resource.type]}</Pill>
          <div>
            <a href={resource.url} target="_blank" rel="noreferrer" className="textlink">
              {resource.url}
            </a>
          </div>
          {resource.description && (
            <div>
              <small>{resource.description}</small>
            </div>
          )}
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={onEdit} disabled={busy}>
            Edit
          </button>
          <button type="button" className="btn" onClick={remove} disabled={busy}>
            {busy ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
      {error && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </div>
  );
}

type ResourceFormProps =
  | { mode: "create"; campaignRef: string; version: number; onSaved: (campaign: CampaignDto) => void; onCancel: () => void }
  | { mode: "edit"; campaignRef: string; version: number; resource: CampaignResource; onSaved: (campaign: CampaignDto) => void; onCancel: () => void };

function ResourceForm(props: ResourceFormProps) {
  const initial = props.mode === "edit" ? props.resource : null;
  const [label, setLabel] = useState(initial?.label ?? "");
  const [type, setType] = useState<CampaignResourceType>(initial?.type ?? "LINK");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const result =
      props.mode === "create"
        ? await addCampaignResource(props.campaignRef, { label, type, url, description: description.trim() || undefined, expectedVersion: props.version })
        : await editCampaignResource(props.campaignRef, { resourceRef: props.resource.resourceRef, label, type, url, description: description.trim() || null, expectedVersion: props.version });

    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    props.onSaved(result.data);
  }

  return (
    <form onSubmit={handleSubmit} className="record" style={{ marginBottom: 14 }}>
      <div className="fields">
        <div className="field">
          <label>Label / title</label>
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={200} />
        </div>
        <div className="field">
          <label>Type</label>
          <select value={type} onChange={(e) => setType(e.target.value as CampaignResourceType)}>
            {CAMPAIGN_RESOURCE_TYPES.map((t) => (
              <option key={t} value={t}>
                {RESOURCE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="field full">
          <label>URL / reference</label>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required maxLength={1000} placeholder="https://…" />
        </div>
        <div className="field full">
          <label>Description (optional)</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
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
        <button type="submit" className="btn primary" disabled={saving || !label.trim() || !url.trim()}>
          {saving ? "Saving…" : props.mode === "create" ? "Add resource" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
