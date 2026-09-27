"use client";

import { useEffect, useState } from "react";

import { Pill } from "@/ui/Badge";
import { DialogShell } from "@/ui/Dialog";
import { EmptyState, Skeleton } from "@/ui/States";
import type { MeetingDto, OwnerType } from "@/server/notes-meetings";

import { createMeeting, listMeetings } from "./api-client";
import { absoluteTime, MEETING_STATUS_LABELS, meetingStatusTone } from "./format";
import { MeetingDetailDialog } from "./MeetingDetailDialog";
import { UserPicker, type PickedUser } from "./UserPicker";
import { useLatestRequest } from "./use-latest-request";

type Props = { ownerType: OwnerType; ownerRef: string; canManage: boolean };

export function MeetingThread({ ownerType, ownerRef, canManage }: Props) {
  const [meetings, setMeetings] = useState<MeetingDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openMeetingRef, setOpenMeetingRef] = useState<string | null>(null);
  // See use-latest-request.ts: guards the mount fetch below against resolving AFTER a later refresh()
  // (e.g. right after creating a Meeting) and overwriting fresher data with a stale list.
  const latest = useLatestRequest();

  async function refresh() {
    const id = latest.start();
    const result = await listMeetings({ ownerType, ownerRef });
    if (!latest.isCurrent(id)) return;
    if (result.ok) {
      setError(null);
      setMeetings(result.data.meetings);
    } else {
      setError(result.message);
    }
  }

  useEffect(() => {
    const id = latest.start();
    listMeetings({ ownerType, ownerRef }).then((result) => {
      if (!latest.isCurrent(id)) return;
      if (result.ok) setMeetings(result.data.meetings);
      else setError(result.message);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `latest` is a stable ref-backed helper, not reactive state.
  }, [ownerType, ownerRef]);

  return (
    <div>
      {canManage && (
        <div className="actions" style={{ marginBottom: 16 }}>
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            Create meeting
          </button>
        </div>
      )}

      {error && (
        <div className="banner" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {meetings === null && <Skeleton lines={3} />}
      {meetings !== null && meetings.length === 0 && <EmptyState title="No meetings yet" description="Meetings recorded for this record will appear here." icon="clock" />}
      {meetings !== null &&
        meetings.map((meeting) => (
          <button key={meeting.meetingRef} type="button" className="attention" style={{ width: "100%", textAlign: "left", marginBottom: 10 }} onClick={() => setOpenMeetingRef(meeting.meetingRef)}>
            <span className="tile">{meeting.status === "CANCELLED" ? "×" : "◷"}</span>
            <span className="grow">
              <strong>{meeting.redacted ? "Restricted meeting" : meeting.title}</strong>
              <small>
                {absoluteTime(meeting.meetingAt)} · organized by {meeting.organizerDisplayName ?? "Unknown"}
              </small>
            </span>
            <Pill tone={meetingStatusTone(meeting.status)}>{MEETING_STATUS_LABELS[meeting.status]}</Pill>
            {meeting.visibility === "RESTRICTED" && <Pill tone="purple">Sensitive</Pill>}
          </button>
        ))}

      {creating && <CreateMeetingDialog ownerType={ownerType} ownerRef={ownerRef} onClose={() => setCreating(false)} onCreated={refresh} />}
      {openMeetingRef && <MeetingDetailDialog meetingRef={openMeetingRef} canManage={canManage} onClose={() => setOpenMeetingRef(null)} onChanged={refresh} />}
    </div>
  );
}

function CreateMeetingDialog({ ownerType, ownerRef, onClose, onCreated }: { ownerType: OwnerType; ownerRef: string; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [meetingAt, setMeetingAt] = useState("");
  const [participants, setParticipants] = useState<PickedUser[]>([]);
  const [agenda, setAgenda] = useState("");
  const [summary, setSummary] = useState("");
  const [decisions, setDecisions] = useState<string[]>([]);
  const [decisionDraft, setDecisionDraft] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!title.trim() || !meetingAt) {
      setError("Title and date/time are required.");
      return;
    }
    setBusy(true);
    const result = await createMeeting({
      owner: { ownerType, ownerRef },
      title: title.trim(),
      meetingAt: new Date(meetingAt).toISOString(),
      participants: participants.map((p) => ({ userRef: p.userRef })),
      agenda: agenda.trim() || null,
      summary: summary.trim() || null,
      decisions: decisions.map((text) => ({ text })),
      visibility: sensitive ? "RESTRICTED" : "STANDARD",
    });
    setBusy(false);
    if (result.ok) {
      onCreated();
      onClose();
    } else {
      setError(result.message);
    }
  }

  return (
    <DialogShell
      open
      title="Create meeting"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={submit}>
            {busy ? "Creating…" : "Create meeting"}
          </button>
        </>
      }
    >
      <div className="fields">
        <div className="field full">
          <label htmlFor="meeting-title">Title</label>
          <input id="meeting-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </div>
        <div className="field">
          <label htmlFor="meeting-at">Date/time</label>
          <input id="meeting-at" type="datetime-local" value={meetingAt} onChange={(e) => setMeetingAt(e.target.value)} />
        </div>
        <div className="field full">
          <UserPicker id="meeting-participants" label="Participants" multi value={participants} onChange={setParticipants} />
        </div>
        <div className="field full">
          <label htmlFor="meeting-agenda">Agenda</label>
          <textarea id="meeting-agenda" value={agenda} onChange={(e) => setAgenda(e.target.value)} maxLength={4000} />
        </div>
        <div className="field full">
          <label htmlFor="meeting-summary">Summary / MoM</label>
          <textarea id="meeting-summary" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={8000} />
        </div>
        <div className="field full">
          <label htmlFor="meeting-decision">Decisions</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input id="meeting-decision" type="text" value={decisionDraft} onChange={(e) => setDecisionDraft(e.target.value)} maxLength={2000} />
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (decisionDraft.trim()) {
                  setDecisions([...decisions, decisionDraft.trim()]);
                  setDecisionDraft("");
                }
              }}
            >
              Add
            </button>
          </div>
          {decisions.length > 0 && (
            <ul style={{ marginTop: 8, paddingLeft: 18 }}>
              {decisions.map((d, i) => (
                <li key={i}>
                  {d}{" "}
                  <button type="button" className="textlink" onClick={() => setDecisions(decisions.filter((_, j) => j !== i))}>
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="field full">
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
            Mark this meeting sensitive
          </label>
        </div>
      </div>
      {error && (
        <div className="banner" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
    </DialogShell>
  );
}
