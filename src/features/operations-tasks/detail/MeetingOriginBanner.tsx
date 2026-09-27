"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { findActionItemByTask, ownerDetailHref } from "@/features/notes-meetings/api-client";

// Notes/Meetings Completion (spec section 19: "navigable in both directions where authorized") - the
// Task-side half of the bidirectional deep link. The Meeting side already shows a real, permanent
// link to its promoted Task (MeetingDetailDialog's own ActionItemRow); this is the reverse: if THIS
// actor can also see the owning Meeting, a small banner links to the REAL owner record (Meetings have
// no standalone route of their own - they live inside the owner's Notes & Meetings tab/dialog, so the
// honest destination is that record, not a fabricated Meeting URL). A denial and a genuine absence
// look identical (no banner) - never a hint that a link exists the actor cannot see.
export function MeetingOriginBanner({ taskRef }: { taskRef: string }) {
  const [href, setHref] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    findActionItemByTask(taskRef).then((result) => {
      if (cancelled || !result.ok || !result.data.found || !result.data.ownerType || !result.data.ownerRef) return;
      const link = ownerDetailHref(result.data.ownerType, result.data.ownerRef);
      if (link) setHref(link);
    });
    return () => {
      cancelled = true;
    };
  }, [taskRef]);

  if (!href) return null;

  return (
    <div className="banner" role="status" style={{ marginBottom: 14 }}>
      This Task was promoted from a Meeting Action Item.{" "}
      <Link href={href} className="textlink">
        View source record (Notes &amp; meetings)
      </Link>
    </div>
  );
}
