import { getUserDoc } from "./firestore";
import type { ActorContext } from "./types";

// Resolves an authenticated session's uid into a full actor context. This
// is the "Active User / Admission" pipeline stage: it returns null - and
// every caller must treat null as "not authorized, full stop" - when:
//   - there is no users/{uid} document (missing access profile)
//   - the document doesn't parse against userDocSchema (malformed profile)
//   - the document's own uid field disagrees with the lookup key (data
//     integrity issue - treated as malformed, not silently trusted)
//   - the user is marked inactive (admission denied)
// These are deliberately indistinguishable to callers: the failure mode
// is uniform so nothing about *why* an actor was rejected leaks out.
export async function resolveActor(uid: string): Promise<ActorContext | null> {
  const userDoc = await getUserDoc(uid);
  if (!userDoc) return null;
  if (userDoc.uid !== uid) return null;
  if (!userDoc.active) return null;

  return {
    uid: userDoc.uid,
    email: userDoc.email,
    role: userDoc.role,
    displayName: userDoc.displayName,
  };
}
