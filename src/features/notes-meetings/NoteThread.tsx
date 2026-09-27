"use client";

import { useEffect, useState, type ChangeEvent } from "react";

import { Pill } from "@/ui/Badge";
import { DialogShell } from "@/ui/Dialog";
import { EmptyState, Skeleton } from "@/ui/States";
import type { NoteDto, NoteVersionDto, OwnerType } from "@/server/notes-meetings";

import { archiveNote, attachmentDownloadHref, createNote, listNoteAttachments, listNotes, listNoteVersions, reviseNote, uploadNoteAttachment, type NmApiResult } from "./api-client";
import { absoluteTime, NOTE_STATUS_LABELS, noteStatusTone } from "./format";
import { useLatestRequest } from "./use-latest-request";

type Props = { ownerType: OwnerType; ownerRef: string; canManage: boolean };

export function NoteThread({ ownerType, ownerRef, canManage }: Props) {
  const [notes, setNotes] = useState<NoteDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [historyFor, setHistoryFor] = useState<NoteDto | null>(null);
  // See use-latest-request.ts's own comment: guards against the mount-time fetch below resolving
  // AFTER a later refresh() (e.g. right after creating a note) and overwriting fresher data with a
  // stale, pre-mutation list.
  const latest = useLatestRequest();

  async function refresh() {
    const id = latest.start();
    const result = await listNotes({ ownerType, ownerRef });
    if (!latest.isCurrent(id)) return;
    if (result.ok) {
      setError(null);
      setNotes(result.data.notes);
    } else {
      setError(result.message);
    }
  }

  useEffect(() => {
    const id = latest.start();
    listNotes({ ownerType, ownerRef }).then((result) => {
      if (!latest.isCurrent(id)) return;
      if (result.ok) setNotes(result.data.notes);
      else setError(result.message);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `latest` is a stable ref-backed helper, not reactive state.
  }, [ownerType, ownerRef]);

  async function handleCreate() {
    if (!draft.trim()) return;
    setSubmitting(true);
    const result = await createNote({ owner: { ownerType, ownerRef }, body: draft.trim(), visibility: sensitive ? "RESTRICTED" : "STANDARD" });
    setSubmitting(false);
    if (result.ok) {
      setDraft("");
      setSensitive(false);
      await refresh();
    } else {
      setError(result.message);
    }
  }

  async function handleArchive(note: NoteDto) {
    const reason = window.prompt("Why are you archiving this note?");
    if (!reason || reason.trim().length < 3) return;
    const result = await archiveNote(note.noteRef, { expectedDocVersion: note.docVersion, reason: reason.trim() });
    if (result.ok) await refresh();
    else setError(result.message);
  }

  return (
    <div>
      {canManage && (
        <div className="field full" style={{ marginBottom: 16 }}>
          <label htmlFor="new-note-body">Add a note</label>
          <textarea id="new-note-body" placeholder="Write a note…" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={4000} />
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12 }}>
            <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
            Mark this note sensitive (hides its content from actors without the sensitive-notes category)
          </label>
          <div className="actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn primary" disabled={submitting || !draft.trim()} onClick={handleCreate}>
              {submitting ? "Saving…" : "Save note"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="banner" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {notes === null && <Skeleton lines={3} />}
      {notes !== null && notes.length === 0 && <EmptyState title="No notes yet" description="Notes added to this record will appear here." icon="clock" />}
      {notes !== null &&
        notes.map((note) => (
          <div key={note.noteRef} className="attention" style={{ display: "block", marginBottom: 10, cursor: "default" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div style={{ flex: 1 }}>
                {note.redacted ? <p className="foundationnote">Restricted note - you do not have access to view its content.</p> : <p className="detailcopy">{note.body}</p>}
                <small style={{ display: "block", marginTop: 6 }}>
                  {note.createdByDisplayName ?? "Unknown"} · {absoluteTime(note.createdAt)}
                  {note.latestVersion > 1 ? ` · revised (v${note.latestVersion})` : ""}
                </small>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                <Pill tone={noteStatusTone(note.status)}>{NOTE_STATUS_LABELS[note.status]}</Pill>
                {note.visibility === "RESTRICTED" && <Pill tone="purple">Sensitive</Pill>}
              </div>
            </div>
            <div className="actions" style={{ marginTop: 10 }}>
              <button type="button" className="btn" onClick={() => setHistoryFor(note)}>
                History
              </button>
              {canManage && note.status === "ACTIVE" && !note.redacted && <ReviseNoteInline note={note} onDone={refresh} />}
              {canManage && note.status === "ACTIVE" && (
                <button type="button" className="btn" onClick={() => handleArchive(note)}>
                  Archive
                </button>
              )}
            </div>
            <AttachmentsInline noteRef={note.noteRef} canManage={canManage} redacted={note.redacted} />
          </div>
        ))}

      {historyFor && <NoteHistoryDialog note={historyFor} onClose={() => setHistoryFor(null)} />}
    </div>
  );
}

function ReviseNoteInline({ note, onDone }: { note: NoteDto; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(note.body ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        Revise
      </button>
    );
  }

  async function submit() {
    if (!body.trim() || reason.trim().length < 3) return;
    setBusy(true);
    const result = await reviseNote(note.noteRef, { expectedDocVersion: note.docVersion, body: body.trim(), reason: reason.trim() });
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      onDone();
    } else {
      setError(result.message);
    }
  }

  return (
    <div className="field full" style={{ width: "100%", marginTop: 8 }}>
      <label htmlFor={`revise-note-body-${note.noteRef}`}>Revise note</label>
      <textarea id={`revise-note-body-${note.noteRef}`} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} />
      <label htmlFor={`revise-note-reason-${note.noteRef}`} style={{ marginTop: 6 }}>
        Reason for this revision
      </label>
      <input id={`revise-note-reason-${note.noteRef}`} type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being revised?" />
      {error && <p className="foundationnote">{error}</p>}
      <div className="actions" style={{ marginTop: 8 }}>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={submit}>
          {busy ? "Saving…" : "Save revision"}
        </button>
      </div>
    </div>
  );
}

function NoteHistoryDialog({ note, onClose }: { note: NoteDto; onClose: () => void }) {
  const [versions, setVersions] = useState<NoteVersionDto[] | null>(null);

  useEffect(() => {
    let active = true;
    void listNoteVersions(note.noteRef).then((result: NmApiResult<{ versions: NoteVersionDto[] }>) => {
      if (active && result.ok) setVersions(result.data.versions);
    });
    return () => {
      active = false;
    };
  }, [note.noteRef]);

  return (
    <DialogShell open title="Note history" onClose={onClose}>
      {versions === null && <Skeleton lines={2} />}
      {versions !== null &&
        versions.map((v) => (
          <div key={v.version} className="kv" style={{ display: "block", marginBottom: 10 }}>
            <b>
              Version {v.version} · {v.changeKind === "created" ? "Created" : "Revised"}
            </b>
            <p className="detailcopy">{v.body ?? "Restricted - content hidden."}</p>
            {v.reason && <p className="foundationnote">Reason: {v.reason}</p>}
            <small>
              {v.createdByDisplayName ?? "Unknown"} · {absoluteTime(v.createdAt)}
            </small>
          </div>
        ))}
    </DialogShell>
  );
}

function AttachmentsInline({ noteRef, canManage, redacted }: { noteRef: string; canManage: boolean; redacted: boolean }) {
  const [attachments, setAttachments] = useState<{ attachmentRef: string; fileName: string; sizeBytes: number }[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const latest = useLatestRequest();

  async function refresh() {
    const id = latest.start();
    const result = await listNoteAttachments(noteRef);
    if (!latest.isCurrent(id)) return;
    if (result.ok) setAttachments(result.data.attachments);
  }

  useEffect(() => {
    const id = latest.start();
    listNoteAttachments(noteRef).then((result) => {
      if (!latest.isCurrent(id)) return;
      if (result.ok) setAttachments(result.data.attachments);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `latest` is a stable ref-backed helper, not reactive state.
  }, [noteRef]);

  if (redacted) return null;

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploading(true);
    await uploadNoteAttachment(noteRef, file);
    setUploading(false);
    await refresh();
  }

  if (!attachments || (attachments.length === 0 && !canManage)) return null;

  return (
    <div style={{ marginTop: 8 }}>
      {attachments.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
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
        <label className="btn" style={{ marginTop: 6, display: "inline-block", cursor: "pointer" }}>
          {uploading ? "Uploading…" : "Attach file"}
          <input type="file" style={{ display: "none" }} onChange={handleUpload} disabled={uploading} />
        </label>
      )}
    </div>
  );
}
