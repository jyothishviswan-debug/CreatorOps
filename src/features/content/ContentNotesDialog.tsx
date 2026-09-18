"use client";

import { DialogShell } from "@/ui/Dialog";
import { EmptyState } from "@/ui/States";

// Step 11B: mirrors src/features/assignments/AssignmentNotesDialog.tsx
// exactly - Notes/Meetings has no trusted backend yet, so this is a
// truthful neutral unavailable state, never a hardcoded fake note.
export function ContentNotesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <DialogShell open={open} title="Notes & meetings" onClose={onClose}>
      <EmptyState title="Not yet built" description="No real trusted source is wired to this Content record yet." icon="clock" />
    </DialogShell>
  );
}
