"use client";

import { useEffect, useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import { listContent } from "@/features/content/api-client";
import { contentDisplayTitle } from "@/features/content/format";
import type { ContentDto } from "@/server/content/client-dto";
import type { AnalyticsPartnerAccountCandidateDto } from "@/server/analytics/partner-account-candidates";

import type { ExplorerRecord } from "./AnalyticsExplorerWorkspace";
import { resolveAnalyticsSourceRecordMatch, searchAnalyticsPartnerAccountCandidates } from "./api-client";

// The channel-side candidate search reuses a NEW, minimal, bounded/
// scoped/authorized endpoint built for this step (searchAnalyticsPartnerAccountCandidates
// - see server/analytics/partner-account-candidates.ts) - no existing
// cross-partner Partner Account search endpoint was found anywhere in
// this codebase before this step. The content-side candidate search
// reuses the EXISTING, already-scoped GET /api/content?status=APPROVED
// endpoint unchanged - it has no free-text query parameter of its own,
// so this dialog fetches one bounded page of APPROVED Content and lets
// the actor filter/pick from that already-loaded, already-authorized
// list (the same honest "search what's already loaded" idiom every
// Workspace's own page-scoped search already uses in this app), rather
// than inventing a new "search all Content" endpoint.
export function AnalyticsResolveMatchDialog({
  record,
  recordKind,
  open,
  onClose,
  onResolved,
}: {
  record: ExplorerRecord;
  recordKind: "content" | "channel";
  open: boolean;
  onClose: () => void;
  onResolved: (updated: { matchState: string; correctionRevision: number }) => void;
}) {
  const [contentCandidates, setContentCandidates] = useState<ContentDto[]>([]);
  const [accountCandidates, setAccountCandidates] = useState<AnalyticsPartnerAccountCandidateDto[]>([]);
  const [candidateFilter, setCandidateFilter] = useState("");
  const [accountQuery, setAccountQuery] = useState("");
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  // The parent (AnalyticsExplorerWorkspace) mounts this dialog with
  // `key={record.sourceRef}`, so switching which record is being
  // resolved remounts it fresh - every useState above already starts at
  // its correct initial value with no reset-in-effect needed. This
  // effect only ever starts the (async) candidate fetch - it never calls
  // setState synchronously in its own body.
  useEffect(() => {
    if (!open) return;
    if (recordKind === "content") {
      listContent({ status: "APPROVED", limit: 20 }).then((result) => {
        if (result.ok) setContentCandidates(result.data.content);
      });
    } else {
      void runAccountSearch("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, record.sourceRef, recordKind]);

  async function runAccountSearch(query: string) {
    const result = await searchAnalyticsPartnerAccountCandidates({ query: query || undefined, platform: record.platform, limit: 10 });
    if (result.ok) setAccountCandidates(result.data);
  }

  async function submit(targetRef: string | null) {
    if (reason.trim().length === 0) {
      setError("A reason is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await resolveAnalyticsSourceRecordMatch({ recordKind, sourceRef: record.sourceRef, targetRef, expectedRevision: record.correctionRevision, reason: reason.trim() });
    setSubmitting(false);
    if (!result.ok) {
      if (result.code === "stale_write") setStale(true);
      setError(result.error);
      return;
    }
    onResolved(result.data);
  }

  const visibleContentCandidates =
    candidateFilter.trim().length === 0
      ? contentCandidates
      : contentCandidates.filter((c) => [contentDisplayTitle(c), c.partnerDisplayName, c.campaignName].filter(Boolean).join(" ").toLowerCase().includes(candidateFilter.trim().toLowerCase()));

  return (
    <DialogShell open={open} title="Resolve match" onClose={onClose}>
      {stale ? (
        <div className="banner" role="alert">
          <b>This record has already been corrected by someone else.</b> Close this dialog and reload the page to see the current state before trying again.
        </div>
      ) : (
        <>
          <p className="foundationnote" style={{ marginBottom: 10 }}>
            Pick a target, or clear the match entirely, then give a reason. This never edits Content/Assignment/Partner/Partner Account records - only this Analytics source record&rsquo;s own match resolution.
          </p>

          {recordKind === "content" ? (
            <>
              <input placeholder="Filter loaded Approved Content…" value={candidateFilter} onChange={(e) => setCandidateFilter(e.target.value)} aria-label="Filter Content candidates" />
              <div className="ov-rankings" style={{ marginTop: 10 }}>
                {visibleContentCandidates.length === 0 ? (
                  <p className="foundationnote">No Approved Content loaded matches this filter.</p>
                ) : (
                  visibleContentCandidates.map((c) => (
                    <label className="ov-rank-item" key={c.contentRef} style={{ cursor: "pointer" }}>
                      <input type="radio" name="candidate" checked={selectedRef === c.contentRef} onChange={() => setSelectedRef(c.contentRef)} />
                      <span>{contentDisplayTitle(c)}</span>
                      <b>{c.partnerDisplayName ?? "Unknown partner"}</b>
                    </label>
                  ))
                )}
              </div>
            </>
          ) : (
            <>
              <div className="inputwrap" style={{ display: "flex", gap: 8 }}>
                <input placeholder="Search Partner Accounts…" value={accountQuery} onChange={(e) => setAccountQuery(e.target.value)} aria-label="Search Partner Account candidates" />
                <button type="button" className="btn" onClick={() => runAccountSearch(accountQuery)}>
                  Search
                </button>
              </div>
              <div className="ov-rankings" style={{ marginTop: 10 }}>
                {accountCandidates.length === 0 ? (
                  <p className="foundationnote">No matching, in-scope Partner Accounts found for this platform.</p>
                ) : (
                  accountCandidates.map((c) => (
                    <label className="ov-rank-item" key={c.partnerAccountRef} style={{ cursor: "pointer" }}>
                      <input type="radio" name="candidate" checked={selectedRef === c.partnerAccountRef} onChange={() => setSelectedRef(c.partnerAccountRef)} />
                      <span>{c.label}</span>
                      <b>{c.partnerDisplayName}</b>
                    </label>
                  ))
                )}
              </div>
            </>
          )}

          <label style={{ display: "block", marginTop: 14 }}>
            Reason (required)
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Why is this the correct match?" aria-label="Correction reason" />
          </label>

          {error && (
            <div className="banner" role="alert" style={{ marginTop: 10 }}>
              {error}
            </div>
          )}

          <div className="dialogfoot" style={{ marginTop: 14 }}>
            <button type="button" className="btn" disabled={submitting} onClick={() => submit(null)}>
              Clear match
            </button>
            <button type="button" className="btn primary" disabled={submitting || !selectedRef} onClick={() => submit(selectedRef)}>
              {submitting ? "Saving…" : "Confirm match"}
            </button>
          </div>
        </>
      )}
    </DialogShell>
  );
}
