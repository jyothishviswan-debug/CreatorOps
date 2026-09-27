"use client";

import { useEffect, useState } from "react";

import { Pill } from "@/ui/Badge";
import { DialogShell } from "@/ui/Dialog";
import { LocalTabs } from "@/ui/LocalTabs";
import { Skeleton } from "@/ui/States";
import type { ActionItemDto, MeetingDto, MeetingVersionDto } from "@/server/notes-meetings";

import {
  attachmentDownloadHref,
  cancelActionItem,
  cancelMeeting,
  completeActionItem,
  createActionItem,
  getMeeting,
  listActionItems,
  listMeetingAttachments,
  listMeetingVersions,
  promoteActionItem,
  reviseMeeting,
  uploadMeetingAttachment,
  type NmApiResult,
} from "./api-client";
import { absoluteTime, ACTION_ITEM_STATUS_LABELS, actionItemStatusTone, MEETING_STATUS_LABELS, meetingStatusTone } from "./format";
import { UserPicker, type PickedUser } from "./UserPicker";
import { useLatestRequest } from "./use-latest-request";

export function MeetingDetailDialog({ meetingRef, canManage, onClose, onChanged }: { meetingRef: string; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const [meeting, setMeeting] = useState<MeetingDto | null>(null);
  const [actionItems, setActionItems] = useState<ActionItemDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"detail" | "history">("detail");
  const [history, setHistory] = useState<MeetingVersionDto[] | null>(null);
  const [attachments, setAttachments] = useState<{ attachmentRef: string; fileName: string; sizeBytes: number }[] | null>(null);
  const [revising, setRevising] = useState(false);
  // See use-latest-request.ts: each of these three independent resources gets its own guard so an
  // out-of-order mount-time fetch can never overwrite fresher post-mutation data.
  const latestMeeting = useLatestRequest();
  const latestActionItems = useLatestRequest();
  const latestAttachments = useLatestRequest();

  async function refreshMeeting() {
    const id = latestMeeting.start();
    const result = await getMeeting(meetingRef);
    if (!latestMeeting.isCurrent(id)) return;
    if (result.ok) setMeeting(result.data);
    else setError(result.message);
  }
  async function refreshActionItems() {
    const id = latestActionItems.start();
    const result = await listActionItems(meetingRef);
    if (!latestActionItems.isCurrent(id)) return;
    if (result.ok) setActionItems(result.data.actionItems);
  }
  async function refreshAttachments() {
    const id = latestAttachments.start();
    const result = await listMeetingAttachments(meetingRef);
    if (!latestAttachments.isCurrent(id)) return;
    if (result.ok) setAttachments(result.data.attachments);
  }

  useEffect(() => {
    const meetingId = latestMeeting.start();
    getMeeting(meetingRef).then((result) => {
      if (!latestMeeting.isCurrent(meetingId)) return;
      if (result.ok) setMeeting(result.data);
      else setError(result.message);
    });
    const actionItemsId = latestActionItems.start();
    listActionItems(meetingRef).then((result) => {
      if (!latestActionItems.isCurrent(actionItemsId)) return;
      if (result.ok) setActionItems(result.data.actionItems);
    });
    const attachmentsId = latestAttachments.start();
    listMeetingAttachments(meetingRef).then((result) => {
      if (!latestAttachments.isCurrent(attachmentsId)) return;
      if (result.ok) setAttachments(result.data.attachments);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- latestX are stable ref-backed helpers, not reactive state.
  }, [meetingRef]);

  useEffect(() => {
    if (tab !== "history") return;
    void listMeetingVersions(meetingRef).then((result: NmApiResult<{ versions: MeetingVersionDto[] }>) => {
      if (result.ok) setHistory(result.data.versions);
    });
  }, [tab, meetingRef]);

  async function afterMutate() {
    await refreshMeeting();
    await refreshActionItems();
    onChanged();
  }

  async function handleCancelMeeting() {
    if (!meeting) return;
    const reason = window.prompt("Why is this meeting being cancelled?");
    if (!reason || reason.trim().length < 3) return;
    const result = await cancelMeeting(meeting.meetingRef, { expectedDocVersion: meeting.docVersion, reason: reason.trim() });
    if (result.ok) await afterMutate();
    else setError(result.message);
  }

  async function handleUpload(file: File) {
    await uploadMeetingAttachment(meetingRef, file);
    await refreshAttachments();
  }

  return (
    <DialogShell open title={meeting?.redacted ? "Restricted meeting" : (meeting?.title ?? "Meeting")} onClose={onClose}>
      {error && (
        <div className="banner" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}
      {!meeting && <Skeleton lines={4} />}
      {meeting && (
        <>
          <LocalTabs
            tabs={[
              { key: "detail", label: "Detail" },
              { key: "history", label: "History" },
            ]}
            active={tab}
            onChange={(key) => setTab(key as "detail" | "history")}
            trailing={<Pill tone={meetingStatusTone(meeting.status)}>{MEETING_STATUS_LABELS[meeting.status]}</Pill>}
          />

          {tab === "detail" && (
            <>
              <div className="kv">
                <span>When</span>
                <b>{absoluteTime(meeting.meetingAt)}</b>
              </div>
              <div className="kv">
                <span>Organizer</span>
                <b>{meeting.organizerDisplayName ?? "Unknown"}</b>
              </div>
              {meeting.redacted ? (
                <p className="foundationnote" style={{ marginTop: 12 }}>
                  Restricted meeting - you do not have access to view participants, agenda, summary or decisions.
                </p>
              ) : (
                <>
                  <div className="kv">
                    <span>Participants</span>
                    <b>{meeting.participants && meeting.participants.length > 0 ? meeting.participants.map((p) => p.displayName ?? p.userRef).join(", ") : "None recorded"}</b>
                  </div>
                  {meeting.agenda && (
                    <div style={{ marginTop: 10 }}>
                      <b>Agenda</b>
                      <p className="detailcopy">{meeting.agenda}</p>
                    </div>
                  )}
                  {meeting.summary && (
                    <div style={{ marginTop: 10 }}>
                      <b>Summary / MoM</b>
                      <p className="detailcopy">{meeting.summary}</p>
                    </div>
                  )}
                  {meeting.decisions && meeting.decisions.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <b>Decisions</b>
                      <ul style={{ paddingLeft: 18 }}>
                        {meeting.decisions.map((d, i) => (
                          <li key={i}>{d}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {canManage && meeting.status !== "CANCELLED" && !revising && (
                    <div className="actions" style={{ marginTop: 12 }}>
                      <button type="button" className="btn" onClick={() => setRevising(true)}>
                        Revise
                      </button>
                      <button type="button" className="btn" onClick={handleCancelMeeting}>
                        Cancel meeting
                      </button>
                    </div>
                  )}
                  {revising && (
                    <ReviseMeetingForm
                      meeting={meeting}
                      onDone={() => {
                        setRevising(false);
                        void afterMutate();
                      }}
                      onCancel={() => setRevising(false)}
                    />
                  )}

                  <div style={{ marginTop: 16 }}>
                    <b>Attachments</b>
                    {attachments && attachments.length > 0 && (
                      <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                        {attachments.map((a) => (
                          <li key={a.attachmentRef}>
                            <a href={attachmentDownloadHref(a.attachmentRef)} className="textlink">
                              {a.fileName}
                            </a>{" "}
                            <small>({Math.max(1, Math.round(a.sizeBytes / 1024))} KB)</small>
                          </li>
                        ))}
                      </ul>
                    )}
                    {canManage && (
                      <label className="btn" style={{ marginTop: 8, display: "inline-block", cursor: "pointer" }}>
                        Attach file
                        <input
                          type="file"
                          style={{ display: "none" }}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = "";
                            if (file) void handleUpload(file);
                          }}
                        />
                      </label>
                    )}
                  </div>

                  <div style={{ marginTop: 18 }}>
                    <b>Action items</b>
                    <ActionItemsPanel meetingRef={meeting.meetingRef} meetingDocVersion={meeting.docVersion} meetingStatus={meeting.status} canManage={canManage} items={actionItems} onChanged={afterMutate} />
                  </div>
                </>
              )}
            </>
          )}

          {tab === "history" && (
            <>
              {history === null && <Skeleton lines={2} />}
              {history !== null &&
                history.map((v) => (
                  <div key={v.version} style={{ marginBottom: 12 }}>
                    <b>
                      Version {v.version} · {v.changeKind === "created" ? "Created" : "Revised"}
                    </b>
                    {v.reason && <p className="foundationnote">Reason: {v.reason}</p>}
                    <small style={{ display: "block" }}>
                      {v.createdByDisplayName ?? "Unknown"} · {absoluteTime(v.createdAt)}
                    </small>
                  </div>
                ))}
            </>
          )}
        </>
      )}
    </DialogShell>
  );
}

function ReviseMeetingForm({ meeting, onDone, onCancel }: { meeting: MeetingDto; onDone: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState(meeting.title);
  const [summary, setSummary] = useState(meeting.summary ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (reason.trim().length < 3) {
      setError("A reason (at least 3 characters) is required.");
      return;
    }
    setBusy(true);
    const result = await reviseMeeting(meeting.meetingRef, { expectedDocVersion: meeting.docVersion, title: title.trim(), summary: summary.trim() || null, reason: reason.trim() });
    setBusy(false);
    if (result.ok) onDone();
    else setError(result.message);
  }

  return (
    <div className="field full" style={{ marginTop: 12 }}>
      <label htmlFor={`revise-meeting-title-${meeting.meetingRef}`}>Title</label>
      <input id={`revise-meeting-title-${meeting.meetingRef}`} type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      <label htmlFor={`revise-meeting-summary-${meeting.meetingRef}`} style={{ marginTop: 8 }}>
        Summary / MoM
      </label>
      <textarea id={`revise-meeting-summary-${meeting.meetingRef}`} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={8000} />
      <label htmlFor={`revise-meeting-reason-${meeting.meetingRef}`} style={{ marginTop: 8 }}>
        Reason for this revision
      </label>
      <input id={`revise-meeting-reason-${meeting.meetingRef}`} type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
      {error && <p className="foundationnote">{error}</p>}
      <div className="actions" style={{ marginTop: 8 }}>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={submit}>
          {busy ? "Saving…" : "Save revision"}
        </button>
      </div>
    </div>
  );
}

function ActionItemsPanel({ meetingRef, meetingDocVersion, meetingStatus, canManage, items, onChanged }: { meetingRef: string; meetingDocVersion: number; meetingStatus: MeetingDto["status"]; canManage: boolean; items: ActionItemDto[] | null; onChanged: () => void }) {
  const [text, setText] = useState("");
  const [assignee, setAssignee] = useState<PickedUser | null>(null);
  const [dueAt, setDueAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (!text.trim()) return;
    setBusy(true);
    const result = await createActionItem(meetingRef, { expectedDocVersion: meetingDocVersion, text: text.trim(), assigneeUserRef: assignee?.userRef ?? null, dueAt: dueAt ? new Date(dueAt).toISOString() : null });
    setBusy(false);
    if (result.ok) {
      setText("");
      setAssignee(null);
      setDueAt("");
      onChanged();
    } else {
      setError(result.message);
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      {items === null && <Skeleton lines={2} />}
      {items !== null && items.length === 0 && <p className="foundationnote">No action items yet.</p>}
      {items !== null &&
        items.map((item) => <ActionItemRow key={item.actionItemRef} item={item} canManage={canManage} onChanged={onChanged} />)}

      {canManage && meetingStatus !== "CANCELLED" && (
        <div className="field full" style={{ marginTop: 12 }}>
          <label htmlFor="add-action-item-text">Add action item</label>
          <input id="add-action-item-text" type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="What needs to happen?" maxLength={1000} />
          <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <UserPicker id="action-item-assignee" label="Assignee (optional)" value={assignee} onChange={setAssignee} />
            </div>
            <div>
              <label htmlFor="action-item-due">Due (optional)</label>
              <input id="action-item-due" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </div>
          </div>
          {error && <p className="foundationnote">{error}</p>}
          <div className="actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn primary" disabled={busy || !text.trim()} onClick={handleCreate}>
              {busy ? "Adding…" : "Add action item"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionItemRow({ item, canManage, onChanged }: { item: ActionItemDto; canManage: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assigneeForPromote, setAssigneeForPromote] = useState<PickedUser | null>(null);
  const [showPromoteAssignee, setShowPromoteAssignee] = useState(false);
  const open = item.status === "OPEN" || item.status === "IN_PROGRESS";

  async function handleComplete() {
    setBusy(true);
    const result = await completeActionItem(item.actionItemRef, item.docVersion);
    setBusy(false);
    if (result.ok) onChanged();
    else setError(result.message);
  }
  async function handleCancel() {
    const reason = window.prompt("Why is this action item being cancelled?");
    if (!reason || reason.trim().length < 3) return;
    setBusy(true);
    const result = await cancelActionItem(item.actionItemRef, { expectedDocVersion: item.docVersion, reason: reason.trim() });
    setBusy(false);
    if (result.ok) onChanged();
    else setError(result.message);
  }
  async function handlePromote() {
    if (!item.assigneeUserRef && !assigneeForPromote) {
      setShowPromoteAssignee(true);
      return;
    }
    setBusy(true);
    const result = await promoteActionItem(item.actionItemRef, assigneeForPromote ? { assigneeUserRef: assigneeForPromote.userRef } : {});
    setBusy(false);
    if (result.ok) onChanged();
    else setError(result.message);
  }

  return (
    <div className="kv" style={{ display: "block", padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div>
          <b>{item.text}</b>
          <small style={{ display: "block" }}>
            {item.assigneeDisplayName ? `Assigned to ${item.assigneeDisplayName}` : "Unassigned"}
            {item.dueAt ? ` · due ${absoluteTime(item.dueAt)}` : ""}
          </small>
        </div>
        <Pill tone={actionItemStatusTone(item.status)}>{ACTION_ITEM_STATUS_LABELS[item.status]}</Pill>
      </div>

      {item.promotedTaskRef ? (
        <p className="foundationnote" style={{ marginTop: 6 }}>
          Promoted to Operations Task:{" "}
          <a href={`/operations/tasks/${encodeURIComponent(item.promotedTaskRef)}`} className="textlink">
            {item.promotedTaskDisplayName ?? item.promotedTaskRef.slice(0, 8)}
          </a>
          {item.promotedByDisplayName ? ` · by ${item.promotedByDisplayName}` : ""}
        </p>
      ) : (
        canManage &&
        open && (
          <>
            {showPromoteAssignee && !item.assigneeUserRef && (
              <div style={{ marginTop: 8, maxWidth: 320 }}>
                <UserPicker id={`promote-assignee-${item.actionItemRef}`} label="Choose a Task assignee" value={assigneeForPromote} onChange={setAssigneeForPromote} />
              </div>
            )}
            <div className="actions" style={{ marginTop: 8 }}>
              <button type="button" className="btn" disabled={busy} onClick={handleComplete}>
                Mark done
              </button>
              <button type="button" className="btn" disabled={busy} onClick={handleCancel}>
                Cancel
              </button>
              <button type="button" className="btn primary" disabled={busy || (showPromoteAssignee && !item.assigneeUserRef && !assigneeForPromote)} onClick={handlePromote}>
                {busy ? "Promoting…" : "Promote to Task"}
              </button>
            </div>
          </>
        )
      )}
      {error && <p className="foundationnote">{error}</p>}
    </div>
  );
}
