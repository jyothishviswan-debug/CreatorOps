"use client";

import { useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import type { AssignmentDto } from "@/server/assignments/client-dto";
import type { ContentDto } from "@/server/content/client-dto";
import { generateContentFromAssignment } from "@/features/content/api-client";
import { platformLabel } from "@/features/content/format";

// Step 11B: opened from AssignmentContentPanel.tsx, not from Content's
// own pages - Content can only be created contextually, from an
// Assignment's own Content panel (no /content/new route anywhere). Every
// input here is fixed/derived from the ALREADY-LOADED Assignment context
// - never a new fetch of other Campaigns/Partners/Vendors.
export function PlanContentDialog({
  assignment,
  plannedRequiredSlots,
  open,
  onClose,
  onCreated,
}: {
  assignment: AssignmentDto;
  plannedRequiredSlots: number;
  open: boolean;
  onClose: () => void;
  onCreated: (content: ContentDto) => void;
}) {
  const requiredCount = assignment.brief.requiredCount ?? 1;
  const formatOptions = assignment.brief.formats;
  const platformOptions = assignment.brief.platforms;
  const accountOptions = assignment.partnerAccountRefs.map((ref, i) => ({ ref, label: assignment.partnerAccountLabels[i] ?? `Account ${i + 1}` }));

  const [asExtra, setAsExtra] = useState(false);
  const [contentType, setContentType] = useState(formatOptions[0] ?? "");
  const [platform, setPlatform] = useState(platformOptions[0] ?? "");
  const [partnerAccountRef, setPartnerAccountRef] = useState(accountOptions[0]?.ref ?? "");
  const [dueAt, setDueAt] = useState(assignment.brief.dueAt ?? "");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdRef, setCreatedRef] = useState<string | null>(null);

  function reset() {
    setAsExtra(false);
    setContentType(formatOptions[0] ?? "");
    setPlatform(platformOptions[0] ?? "");
    setPartnerAccountRef(accountOptions[0]?.ref ?? "");
    setDueAt(assignment.brief.dueAt ?? "");
    setTitle("");
    setError(null);
    setCreatedRef(null);
  }

  function close() {
    reset();
    onClose();
  }

  const noPlatformsAvailable = platformOptions.length === 0;
  const canSubmit = !noPlatformsAvailable && contentType.trim().length > 0 && platform.trim().length > 0;

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await generateContentFromAssignment({
      assignmentRef: assignment.assignmentRef,
      platform,
      contentType: contentType.trim(),
      partnerAccountRef: partnerAccountRef || undefined,
      title: title.trim() ? title.trim() : undefined,
      dueAt: dueAt || undefined,
      asExtra,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCreatedRef(result.data.contentRef);
    onCreated(result.data);
  }

  return (
    <DialogShell
      open={open}
      title="Plan Content"
      onClose={close}
      footer={
        createdRef ? (
          <button type="button" className="btn primary" onClick={close}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={submit} disabled={busy || !canSubmit}>
              {busy ? "Creating…" : "Create Content"}
            </button>
          </>
        )
      }
    >
      {createdRef ? (
        <div className="banner" role="status">
          <b>Content created.</b>{" "}
          <a href={`/content/${createdRef}`}>View the new Content record</a>
        </div>
      ) : (
        <>
          <div className="kv">
            <span>Campaign</span>
            <b>{assignment.brief.campaignName}</b>
          </div>
          <div className="kv">
            <span>Partner</span>
            <b>{assignment.partnerDisplayName ?? "Unknown Partner"}</b>
          </div>
          <div className="kv">
            <span>Review policy</span>
            <b>{assignment.brief.reviewPolicy === "REVIEW_REQUIRED" ? "Review required" : "No pre/post review"}</b>
          </div>
          <div className="kv">
            <span>Required slots planned</span>
            <b>
              {plannedRequiredSlots} of {requiredCount}
            </b>
          </div>

          {noPlatformsAvailable ? (
            <div className="banner" role="alert" style={{ marginTop: 14 }}>
              This Assignment has no permitted platforms yet - add one to its brief before planning Content.
            </div>
          ) : (
            <>
              <fieldset style={{ marginTop: 14, border: "none", padding: 0 }}>
                <legend className="foundationnote" style={{ marginBottom: 8 }}>
                  Obligation
                </legend>
                <div className="actions" role="radiogroup" aria-label="Required vs extra">
                  <label className="btn" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <input type="radio" name="plan-content-obligation" checked={!asExtra} onChange={() => setAsExtra(false)} />
                    Required obligation
                  </label>
                  <label className="btn" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <input type="radio" name="plan-content-obligation" checked={asExtra} onChange={() => setAsExtra(true)} />
                    Extra (non-obligation)
                  </label>
                </div>
              </fieldset>

              <div className="field full" style={{ marginTop: 12 }}>
                <label htmlFor="plan-content-platform">Platform</label>
                <select id="plan-content-platform" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                  {platformOptions.map((p) => (
                    <option key={p} value={p}>
                      {platformLabel(p)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field full">
                <label htmlFor="plan-content-type">Content type</label>
                {formatOptions.length > 0 ? (
                  <select id="plan-content-type" value={contentType} onChange={(e) => setContentType(e.target.value)}>
                    {formatOptions.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input id="plan-content-type" type="text" maxLength={60} value={contentType} onChange={(e) => setContentType(e.target.value)} required />
                )}
              </div>

              {accountOptions.length > 0 && (
                <div className="field full">
                  <label htmlFor="plan-content-account">Account</label>
                  <select id="plan-content-account" value={partnerAccountRef} onChange={(e) => setPartnerAccountRef(e.target.value)}>
                    {accountOptions.map((a) => (
                      <option key={a.ref} value={a.ref}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="field full">
                <label htmlFor="plan-content-due">Due date</label>
                <input id="plan-content-due" type="date" value={dueAt ?? ""} onChange={(e) => setDueAt(e.target.value)} />
              </div>

              <div className="field full">
                <label htmlFor="plan-content-title">Display title (optional)</label>
                <input id="plan-content-title" type="text" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
            </>
          )}

          {error && (
            <div className="banner" role="alert" style={{ marginTop: 10 }}>
              {error}
            </div>
          )}
        </>
      )}
    </DialogShell>
  );
}
