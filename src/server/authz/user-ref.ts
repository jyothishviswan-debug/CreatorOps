import { randomUUID } from "node:crypto";

// The opaque, browser-facing handle for a user. Pure random - it encodes
// nothing about the underlying Firebase uid, so there is no decoding
// attack surface (unlike a signed/encoded token, which a client could
// still read even if it can't forge one). Resolution is a strict-equality
// lookup (see getUserDocByRef in firestore.ts): a tampered or guessed
// value simply matches nothing.
export function generateUserRef(): string {
  return randomUUID();
}
