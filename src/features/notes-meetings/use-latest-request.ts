import { useRef } from "react";

// Notes/Meetings Completion: a real bug found and fixed during Playwright verification (not a test
// artifact - reproduced under both `next dev` and a production `next build`/`next start`, and
// confirmed via a direct server round trip that the CREATE itself always succeeds and persists; only
// the client's own list state was wrong). Root cause: a component's mount-time fetch (e.g. NoteThread's
// own initial `listNotes` call) and a LATER mutation's own post-write refresh() are two independent,
// unordered network round trips - under real latency (or simply enough background load), the SLOWER,
// EARLIER-STARTED mount fetch can resolve AFTER the faster, LATER-STARTED refresh, silently
// overwriting the correct just-created data with the stale pre-create list. This is a real, user-
// facing race (any user who clicks "Save" quickly after the page loads could see their own new note
// vanish), not specific to tests.
//
// Fix: every fetch that eventually calls setState here is tagged with a monotonically increasing id
// at the moment it is ISSUED; its result is only applied if it is still the MOST RECENTLY issued
// fetch when the response arrives. An out-of-order, superseded response is silently dropped.
export function useLatestRequest() {
  const counter = useRef(0);

  function start(): number {
    counter.current += 1;
    return counter.current;
  }

  function isCurrent(id: number): boolean {
    return id === counter.current;
  }

  return { start, isCurrent };
}
