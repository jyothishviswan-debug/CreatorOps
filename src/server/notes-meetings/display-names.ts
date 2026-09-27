import { getUserDocByRef } from "@/server/authz/firestore";

// Notes/Meetings Completion: the same safe users/{uid}.displayName lookup every other module already
// keeps its own small copy of (see src/server/operations/display-names.ts's own comment) - a
// deliberate, minor duplication that keeps Notes/Meetings' only cross-module dependency the explicit
// promotion call, never a general Operations import for something this generic.
export async function resolveDisplayName(userRef: string | null): Promise<string | null> {
  if (!userRef) return null;
  const doc = await getUserDocByRef(userRef);
  return doc?.displayName ?? null;
}

export async function resolveDisplayNames(userRefs: (string | null)[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(userRefs.filter((ref): ref is string => Boolean(ref)))];
  const pairs = await Promise.all(unique.map(async (userRef): Promise<[string, string | null]> => [userRef, await resolveDisplayName(userRef)]));
  return new Map(pairs);
}
