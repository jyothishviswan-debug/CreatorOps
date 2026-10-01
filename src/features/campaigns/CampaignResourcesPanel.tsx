"use client";

import { useState, type FormEvent } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { EmptyState } from "@/ui/States";
import type { CampaignDto } from "@/server/campaigns/client-dto";
import { CAMPAIGN_RESOURCE_CURRENT_TYPES, type CampaignResource, type CampaignResourceType } from "@/server/campaigns/types";
import { addCampaignResource, addCampaignResourceUpload, editCampaignResource, removeCampaignResource } from "./api-client";
import { RESOURCE_TYPE_LABELS } from "./format";

// Findings #36/#37 (user-decided): exactly 3 real, creatable types - Link
// (validated URL), Upload (a real file, via the canonical
// resource-storage abstraction - fake/offline in tests, real Drive only
// with explicit opt-in), Text (plain text/details, no URL required). The
// 4 legacy types (Document/Brief/Asset/Other) stay readable/displayable
// on already-stored resources but are never newly creatable - see
// campaign-service.ts's own comment. Each mutation (add/edit/remove) uses
// its own dedicated endpoint and the Campaign's optimistic version,
// mirroring Vendors'/Partners' own relationship-panel idiom.
type CreateType = (typeof CAMPAIGN_RESOURCE_CURRENT_TYPES)[number];
export function CampaignResourcesPanel({ campaign, onSaved }: { campaign: CampaignDto; onSaved: (campaign: CampaignDto) => void }) {
  const [creating, setCreating] = useState(false);
  const [editingRef, setEditingRef] = useState<string | null>(null);

  return (
    <Panel span={12}>
      <PanelHead
        title="Resources"
        description="Links, uploaded files, and plain-text notes for this Campaign. No restricted content."
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
          {resource.type === "TEXT" ? (
            <div>
              <small>{resource.content}</small>
            </div>
          ) : (
            resource.url && (
              <div>
                <a href={resource.url} target="_blank" rel="noreferrer" className="textlink">
                  {resource.type === "UPLOAD" ? "Open file" : resource.url}
                </a>
              </div>
            )
          )}
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

// Findings #36/#37: in edit mode, the resource's TYPE is fixed - a legacy
// resource (DOCUMENT/BRIEF/ASSET/OTHER) can still have its label/url/
// description edited (never re-typed into one of the current 3, since
// editResourceInputSchema's `type` only accepts LINK/UPLOAD/TEXT - leaving
// it unset keeps whatever type the resource already has), and UPLOAD has no
// re-upload flow at all (only label/description are editable; its
// storage-returned url is left untouched).
function ResourceForm(props: ResourceFormProps) {
  const initial = props.mode === "edit" ? props.resource : null;
  const effectiveType: CampaignResourceType = initial?.type ?? "LINK";
  const [label, setLabel] = useState(initial?.label ?? "");
  const [type, setType] = useState<CreateType>("LINK");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isText = props.mode === "create" ? type === "TEXT" : effectiveType === "TEXT";
  const isUpload = props.mode === "create" ? type === "UPLOAD" : effectiveType === "UPLOAD";
  const isLink = !isText && !isUpload;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const result =
      props.mode === "create"
        ? type === "UPLOAD"
          ? await addCampaignResourceUpload(props.campaignRef, { label, description: description.trim() || undefined, file: file!, expectedVersion: props.version })
          : await addCampaignResource(props.campaignRef, {
              label,
              type,
              url: type === "LINK" ? url : undefined,
              content: type === "TEXT" ? content : undefined,
              description: description.trim() || undefined,
              expectedVersion: props.version,
            })
        : await editCampaignResource(props.campaignRef, {
            resourceRef: props.resource.resourceRef,
            label,
            url: isLink ? url : undefined,
            content: isText ? content : undefined,
            description: description.trim() || null,
            expectedVersion: props.version,
          });

    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    props.onSaved(result.data);
  }

  const submitDisabled = !label.trim() || (isLink && !url.trim()) || (isUpload && props.mode === "create" && !file) || (isText && !content.trim());

  return (
    <form onSubmit={handleSubmit} className="record" style={{ marginBottom: 14 }}>
      <div className="fields">
        <div className="field">
          <label>Label / title</label>
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={200} />
        </div>
        {props.mode === "create" ? (
          <div className="field">
            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value as CreateType)}>
              {CAMPAIGN_RESOURCE_CURRENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {RESOURCE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="field">
            <label>Type</label>
            <input type="text" value={RESOURCE_TYPE_LABELS[effectiveType]} disabled readOnly />
          </div>
        )}
        {isLink && (
          <div className="field full">
            <label>URL / reference</label>
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required maxLength={1000} placeholder="https://…" />
          </div>
        )}
        {isText && (
          <div className="field full">
            <label>Text content</label>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} required maxLength={4000} rows={4} />
          </div>
        )}
        {isUpload && props.mode === "create" && (
          <div className="field full">
            <label>File</label>
            <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
          </div>
        )}
        {isUpload && props.mode === "edit" && (
          <div className="field full">
            <small>Uploaded files can&rsquo;t be re-uploaded here - remove and add a new one instead.</small>
          </div>
        )}
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
        <button type="submit" className="btn primary" disabled={saving || submitDisabled}>
          {saving ? "Saving…" : props.mode === "create" ? "Add resource" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
