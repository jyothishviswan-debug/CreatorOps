import { randomUUID } from "node:crypto";

// Notes/Meetings Completion: opaque random handles, same convention as every other module's own ref
// (Operations `tsk_`/`rmd_`, Finance `agr_`, Exports `exp_`) - a 3-4 char prefix + 20 lowercase hex
// chars from a fresh UUID. Never a deterministic id derived from content (a Note/Meeting is not
// itself a deduplicated-by-content record the way an idempotency claim is).
function randomHex20(): string {
  return randomUUID().replace(/-/g, "").slice(0, 20);
}

export function generateNoteRef(): string {
  return `note_${randomHex20()}`;
}

export function generateMeetingRef(): string {
  return `mtg_${randomHex20()}`;
}

export function generateActionItemRef(): string {
  return `mai_${randomHex20()}`;
}

export function generateAttachmentRef(): string {
  return `att_${randomHex20()}`;
}
