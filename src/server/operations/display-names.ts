import { getUserDocByRef } from "@/server/authz/firestore";

// Step 18B follow-up: a small, additive presentation helper - resolves a userRef to its safe
// users/{uid} displayName, the SAME lookup every other module's own ownerDisplayName/
// partnerDisplayName field already uses (see e.g. src/server/campaigns/client-dto.ts's own
// resolveUserRefAndName). Never imported by client-dto.ts itself (that file stays DB-free - see its
// own "never imports Firestore, the gate, or any business module's internals" boundary, proved by
// operations-static.test.ts); callers here are the service layer, which already talks to Firestore.
// A lookup failure (a since-removed user) resolves to null - the UI falls back to the raw ref, never
// a fabricated name.
export async function resolveDisplayName(userRef: string): Promise<string | null> {
  const doc = await getUserDocByRef(userRef);
  return doc?.displayName ?? null;
}

// Bounded, deduped batch form for a list page - N distinct userRefs cost at most N lookups (never
// per-row-without-dedup), used by listTasks/listReminders.
export async function resolveDisplayNames(userRefs: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(userRefs)];
  const pairs = await Promise.all(unique.map(async (userRef): Promise<[string, string | null]> => [userRef, await resolveDisplayName(userRef)]));
  return new Map(pairs);
}
