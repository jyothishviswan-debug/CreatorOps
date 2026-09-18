"use client";

import { DialogShell } from "@/ui/Dialog";
import { EmptyState } from "@/ui/States";

// Step 10B: the frozen golden-master "Notes & meetings" tab-strip action
// opens a dialog - Notes/Meetings has no trusted backend yet, so this is
// a truthful neutral unavailable state, never a hardcoded fake note.
export function AssignmentNotesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <DialogShell open={open} title="Notes & meetings" onClose={onClose}>
      <EmptyState title="Not yet built" description="No real trusted source is wired to this Assignment yet." icon="clock" />
    </DialogShell>
  );
}
