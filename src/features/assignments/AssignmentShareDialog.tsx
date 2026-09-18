"use client";

import { useEffect, useRef, useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import type { AssignmentDto } from "@/server/assignments/client-dto";
import type { SubmissionRecipientType } from "@/server/assignments/external-submission-types";
import { createSubmissionSession, getAssignment, getAssignmentCurrentVendor } from "./api-client";
import { buildWhatsAppDeepLink, buildWhatsAppShareMessage } from "./whatsapp";
import { SHARE_ELIGIBLE_STATUSES } from "./format";

// Step 10C: the one new secondary Detail-header action - a focused dialog
// reusing the accepted DialogShell, never a new panel/tab/route. The
// checkbox defaults OFF and stays that way until the user explicitly
// confirms "Open WhatsApp": opening this dialog, and toggling the
// checkbox on its own, must never call the session-creation API (section
// 1's own explicit rule) - the ONLY place createSubmissionSession is ever
// called is inside handleConfirm, on the final click.
export function AssignmentShareDialog({ assignment, open, onClose }: { assignment: AssignmentDto; open: boolean; onClose: () => void }) {
  const [includeLink, setIncludeLink] = useState(false);
  const [recipientType, setRecipientType] = useState<SubmissionRecipientType>("PARTNER");
  const [vendorRef, setVendorRef] = useState<string | null>(null);
  const [vendorLabel, setVendorLabel] = useState<string | null>(null);
  const [vendorLoadedFor, setVendorLoadedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copy submission link");
  // A ref, not just the `busy` state - two clicks landing in the same
  // task (a real double-click, or a race between the click and React's
  // next render) would otherwise both close over the same stale
  // `busy === false`, since state updates aren't visible to a closure
  // until after the next render. The ref is read/written synchronously,
  // so this guard is immune to that race even though `disabled={busy}`
  // also protects the common case.
  const creatingRef = useRef(false);

  // A read-only lookup (never session creation) so the Vendor option can
  // be offered only when a current active Vendor genuinely exists - Step
  // 10C section 17's bounded helper endpoint. Loaded once per dialog
  // open, same derived-loading idiom as AssignmentHistoryDialog.
  useEffect(() => {
    if (!open || vendorLoadedFor === assignment.assignmentRef) return;
    let cancelled = false;
    getAssignmentCurrentVendor(assignment.assignmentRef).then((result) => {
      if (cancelled) return;
      setVendorLoadedFor(assignment.assignmentRef);
      if (result.ok && result.data.vendor) {
        setVendorRef(result.data.vendor.vendorRef);
        setVendorLabel(result.data.vendor.displayName);
      } else {
        setVendorRef(null);
        setVendorLabel(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, assignment.assignmentRef, vendorLoadedFor]);

  // Reset all per-open state when the dialog closes - never rediscover a
  // raw token from Firestore later (section 5's own rule); the in-memory
  // token/URL is only ever this component's own transient state.
  function resetAndClose() {
    creatingRef.current = false;
    setIncludeLink(false);
    setRecipientType("PARTNER");
    setBusy(false);
    setError(null);
    setGeneratedUrl(null);
    setCopyLabel("Copy submission link");
    setVendorLoadedFor(null);
    onClose();
  }

  const summary = assignment.brief.instructions ?? assignment.brief.contentRequirementSummary;

  const previewMessage = buildWhatsAppShareMessage({
    campaignName: assignment.brief.campaignName,
    partnerDisplayName: assignment.partnerDisplayName,
    dueAt: assignment.brief.dueAt,
    platforms: assignment.brief.platforms,
    summary,
  });

  async function handleConfirm() {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setError(null);
    setBusy(true);

    // Open a blank tab SYNCHRONOUSLY, before any await, so the browser
    // still attributes it to this click - regardless of checkbox state,
    // since the final confirmation is now always asynchronous (Step
    // 10C.1: every final action re-validates the Assignment first, even
    // when checkbox OFF never touches the session API).
    const pending = window.open("", "_blank");

    // Trusted re-read on every final confirmation, OFF or ON - an
    // Assignment that moved to DRAFT/COMPLETED/CANCELLED, went out of
    // scope, or was deleted after this dialog opened must never be
    // shared from stale client state. This is the ONLY network call the
    // OFF path ever makes - still zero submission sessions, zero tokens.
    const fresh = await getAssignment(assignment.assignmentRef);
    if (!fresh.ok || !SHARE_ELIGIBLE_STATUSES.includes(fresh.data.status)) {
      pending?.close();
      creatingRef.current = false;
      setBusy(false);
      setError(fresh.ok ? "This Assignment is no longer available to share." : fresh.error);
      return;
    }

    const freshSummary = fresh.data.brief.instructions ?? fresh.data.brief.contentRequirementSummary;
    const freshMessageFields = {
      campaignName: fresh.data.brief.campaignName,
      partnerDisplayName: fresh.data.partnerDisplayName,
      dueAt: fresh.data.brief.dueAt,
      platforms: fresh.data.brief.platforms,
      summary: freshSummary,
    };

    if (!includeLink) {
      // No session, no token - the message is rebuilt from the just-
      // revalidated Assignment, never the stale prop.
      const deepLink = buildWhatsAppDeepLink(buildWhatsAppShareMessage(freshMessageFields));
      if (pending) pending.location.href = deepLink;
      else window.open(deepLink, "_blank", "noopener,noreferrer");
      resetAndClose();
      return;
    }

    const recipientRef = recipientType === "VENDOR" ? (vendorRef ?? undefined) : undefined;
    const result = await createSubmissionSession(assignment.assignmentRef, { recipientType, recipientRef });

    if (!result.ok) {
      pending?.close();
      creatingRef.current = false;
      setBusy(false);
      setError(result.error);
      return;
    }

    const url = `${window.location.origin}/submit/${result.data.rawToken}`;
    const deepLink = buildWhatsAppDeepLink(buildWhatsAppShareMessage({ ...freshMessageFields, submissionUrl: url }));

    if (pending) pending.location.href = deepLink;
    else window.open(deepLink, "_blank", "noopener,noreferrer");

    creatingRef.current = false;
    setBusy(false);
    setGeneratedUrl(url);
  }

  async function copyLink() {
    if (!generatedUrl) return;
    try {
      await navigator.clipboard.writeText(generatedUrl);
      setCopyLabel("Copied");
      setTimeout(() => setCopyLabel("Copy submission link"), 2000);
    } catch {
      setCopyLabel("Couldn't copy");
    }
  }

  return (
    <DialogShell
      open={open}
      title="Share Assignment via WhatsApp"
      onClose={resetAndClose}
      footer={
        <>
          <button type="button" className="btn" onClick={resetAndClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy || (includeLink && recipientType === "VENDOR" && !vendorRef)} onClick={handleConfirm}>
            {busy ? "Working…" : "Open WhatsApp"}
          </button>
        </>
      }
    >
      <p style={{ marginBottom: 8 }}>Safe message preview</p>
      <div className="scopebox" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
        {previewMessage}
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 550 }}>
          <input type="checkbox" checked={includeLink} onChange={(e) => setIncludeLink(e.target.checked)} />
          Include public submission link
        </label>
        <small>Use this only when the Partner or current Vendor should submit published platform links through CreatorOps.</small>
      </div>

      {includeLink && (
        <div className="field" style={{ marginTop: 14 }}>
          <label>Submission recipient</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 400 }}>
              <input type="radio" name="recipientType" checked={recipientType === "PARTNER"} onChange={() => setRecipientType("PARTNER")} />
              Partner
            </label>
            {vendorLabel && (
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 400 }}>
                <input type="radio" name="recipientType" checked={recipientType === "VENDOR"} onChange={() => setRecipientType("VENDOR")} />
                Current Vendor — {vendorLabel}
              </label>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="banner" role="alert" style={{ marginTop: 14 }}>
          {error}
        </div>
      )}

      {generatedUrl && (
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="assignment-share-generated-url">Generated submission link</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input id="assignment-share-generated-url" readOnly value={generatedUrl} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn" onClick={copyLink}>
              {copyLabel}
            </button>
          </div>
        </div>
      )}
    </DialogShell>
  );
}
