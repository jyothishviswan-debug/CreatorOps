"use client";

import { useEffect, useState } from "react";

import type { NotesMeetingsUiPermissions, OwnerType } from "@/server/notes-meetings";
import { DialogShell } from "@/ui/Dialog";
import { LocalTabs } from "@/ui/LocalTabs";
import { EmptyState } from "@/ui/States";

import { listNotes } from "./api-client";
import { absoluteTime } from "./format";
import { MeetingThread } from "./MeetingThread";
import { NoteThread } from "./NoteThread";

export type NotesMeetingsSectionProps = { ownerType: OwnerType; ownerRef: string; permissions: NotesMeetingsUiPermissions };

// Notes/Meetings Completion (spec section 14): the one reusable Notes/Meetings surface, embedded
// either as local-tab content (Partner/Vendor/Campaign/Discovery Lead) or inside a dialog
// (Assignment/Content, replacing their prior "Not yet built" placeholder - see
// NotesMeetingsDialog below). Every owner type renders the exact same component; only `ownerType`/
// `ownerRef`/`permissions` differ.
export function NotesMeetingsSection({ ownerType, ownerRef, permissions }: NotesMeetingsSectionProps) {
  const [sub, setSub] = useState<"notes" | "meetings">("notes");

  if (!permissions.canViewNotesMeetings) {
    return <p className="foundationnote">You do not have access to Notes/Meetings for this record.</p>;
  }

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <LocalTabs
          tabs={[
            { key: "notes", label: "Notes" },
            { key: "meetings", label: "Meetings" },
          ]}
          active={sub}
          onChange={(key) => setSub(key as "notes" | "meetings")}
        />
      </div>
      {sub === "notes" && <NoteThread ownerType={ownerType} ownerRef={ownerRef} canManage={permissions.canManageNotes} />}
      {sub === "meetings" && <MeetingThread ownerType={ownerType} ownerRef={ownerRef} canManage={permissions.canManageMeetings} />}
    </div>
  );
}

// Dialog wrapper for the two golden-master-frozen "Notes & meetings" tab-strip slots (Assignment,
// Content) - same open/onClose contract the two placeholder dialogs it replaces already used, so the
// calling detail pages need no structural change beyond swapping the import and adding `ownerRef`/
// `permissions`.
export function NotesMeetingsDialog({ open, onClose, ownerType, ownerRef, permissions }: { open: boolean; onClose: () => void } & NotesMeetingsSectionProps) {
  return (
    <DialogShell open={open} title="Notes & meetings" onClose={onClose}>
      <NotesMeetingsSection ownerType={ownerType} ownerRef={ownerRef} permissions={permissions} />
    </DialogShell>
  );
}

// The compact "Notes & meetings" preview card (golden master's own third grid tile: a snippet plus
// "Open notes →") - used by Assignment/Content in place of their prior hardcoded EmptyState.
export function NotesMeetingsPreviewCard({ ownerType, ownerRef, permissions, onOpen }: NotesMeetingsSectionProps & { onOpen: () => void }) {
  const [preview, setPreview] = useState<{ body: string | null; redacted: boolean; createdByDisplayName: string | null; createdAt: string } | null | undefined>(undefined);

  useEffect(() => {
    if (!permissions.canViewNotesMeetings) return;
    let active = true;
    void listNotes({ ownerType, ownerRef }, { limit: 1 }).then((result) => {
      if (!active) return;
      if (result.ok && result.data.notes.length > 0) {
        const n = result.data.notes[0]!;
        setPreview({ body: n.body, redacted: n.redacted, createdByDisplayName: n.createdByDisplayName, createdAt: n.createdAt });
      } else {
        setPreview(null);
      }
    });
    return () => {
      active = false;
    };
  }, [ownerType, ownerRef, permissions.canViewNotesMeetings]);

  if (!permissions.canViewNotesMeetings) {
    return <EmptyState title="Not available" description="You do not have access to Notes/Meetings for this record." icon="lock" />;
  }

  return (
    <>
      {preview === undefined && <p className="detailcopy">Loading…</p>}
      {preview === null && <p className="detailcopy">No notes yet.</p>}
      {preview && <p className="detailcopy">{preview.redacted ? "Restricted note - no summary access." : `"${preview.body}"`}</p>}
      {preview && (
        <small style={{ display: "block", marginTop: 12 }}>
          {preview.createdByDisplayName ?? "Unknown"} · {absoluteTime(preview.createdAt)}
        </small>
      )}
      <button type="button" className="textlink" style={{ color: "var(--orange)", fontSize: 11, marginTop: 13 }} onClick={onOpen}>
        Open notes →
      </button>
    </>
  );
}
