"use client";

import Image from "next/image";
import { useState } from "react";

import { Icon } from "@/ui/icons";
import type { PublicAssignmentSubmissionDto } from "@/server/assignments/external-submission-types";
import { platformLabel } from "../format";
import { submitPublicLinks } from "./public-api-client";

// Step 10C section 12: mirrors the accepted backend's MAX_SUBMISSION_ROWS
// (external-submission-types.ts) as a plain local constant rather than a
// runtime import - this page must stay importable with zero server-only
// code in its bundle (the token-scoped public route has no CreatorOps
// session at all).
const MAX_ROWS = 10;

type Row = { platform: string; url: string };

function dateLabel(value: string): string {
  return value.length >= 10 ? value.slice(0, 10) : value;
}

// The one privacy-safe state for every invalid/expired/revoked/used/
// non-accepting case - Step 10C section 14 explicitly forbids
// distinguishing these publicly.
function UnavailableCard() {
  return (
    <div className="panel publiccard">
      <div className="panelbody" style={{ textAlign: "center", padding: "40px 24px" }}>
        <span className="tile" style={{ margin: "0 auto 14px" }}>
          <Icon name="lock" />
        </span>
        <h2>This submission link is no longer available.</h2>
        <p className="detailcopy" style={{ marginTop: 8 }}>
          Please contact the CreatorOps team if you need a new link.
        </p>
      </div>
    </div>
  );
}

export function PublicSubmissionPage({ token, initial }: { token: string; initial: PublicAssignmentSubmissionDto | null }) {
  const [submitted, setSubmitted] = useState(false);
  const [rows, setRows] = useState<Row[]>(() => [{ platform: initial?.allowedPlatforms[0] ?? "", url: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  return (
    <div className="publicwrap">
      <div className="publicbrand">
        <span>
          <Image src="/logo.png" alt="" width={16} height={16} style={{ filter: "brightness(0) invert(1)" }} priority />
        </span>
        CreatorOps
      </div>

      {!initial || unavailable ? (
        <UnavailableCard />
      ) : submitted ? (
        <div className="panel publiccard">
          <div className="panelbody" style={{ textAlign: "center", padding: "40px 24px" }}>
            <span className="tile" style={{ margin: "0 auto 14px" }}>
              <Icon name="check" />
            </span>
            <h2>Links submitted successfully</h2>
            <p className="detailcopy" style={{ marginTop: 8 }}>
              This submission link is no longer active.
            </p>
          </div>
        </div>
      ) : (
        <div className="publiccard">
          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="panelbody">
              <h1 style={{ fontSize: 20 }}>{initial.campaignName}</h1>
              <p className="detailcopy" style={{ marginTop: 4 }}>
                {initial.assignmentDisplayContext}
              </p>

              {initial.instructions && (
                <p className="detailcopy" style={{ marginTop: 14 }}>
                  {initial.instructions}
                </p>
              )}

              <div style={{ marginTop: 14 }}>
                {initial.dueAt && (
                  <div className="kv">
                    <span>Due date</span>
                    <b>{dateLabel(initial.dueAt)}</b>
                  </div>
                )}
                {initial.language && (
                  <div className="kv">
                    <span>Language</span>
                    <b>{initial.language}</b>
                  </div>
                )}
                {initial.formats.length > 0 && (
                  <div className="kv">
                    <span>Formats</span>
                    <b>{initial.formats.join(", ")}</b>
                  </div>
                )}
              </div>

              {initial.hashtags.length > 0 && (
                <div className="publictags">
                  {initial.hashtags.map((tag) => (
                    <span className="pill gray" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {initial.resourceLinks.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  {initial.resourceLinks.map((link) => (
                    <div key={link.url}>
                      <a href={link.url} target="_blank" rel="noreferrer noopener">
                        {link.label}
                      </a>
                    </div>
                  ))}
                </div>
              )}

              {initial.reviewPolicyNote && (
                <div className="banner" role="status" style={{ marginTop: 14 }}>
                  {initial.reviewPolicyNote}
                </div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panelhead">
              <div>
                <h2>Submit published links</h2>
                <p>Add the link for each platform you posted to.</p>
              </div>
            </div>
            <div className="panelbody">
              {rows.map((row, index) => (
                <div className="publicrow" key={index}>
                  <select
                    aria-label="Platform"
                    value={row.platform}
                    onChange={(e) => setRows(rows.map((r, i) => (i === index ? { ...r, platform: e.target.value } : r)))}
                  >
                    <option value="" disabled>
                      Select platform
                    </option>
                    {initial.allowedPlatforms.map((platform) => (
                      <option key={platform} value={platform}>
                        {platformLabel(platform)}
                      </option>
                    ))}
                  </select>
                  <input
                    type="url"
                    aria-label="Published URL"
                    placeholder="https://…"
                    value={row.url}
                    onChange={(e) => setRows(rows.map((r, i) => (i === index ? { ...r, url: e.target.value } : r)))}
                  />
                  {rows.length > 1 && (
                    <button type="button" className="btn ghost" aria-label="Remove row" onClick={() => setRows(rows.filter((_, i) => i !== index))}>
                      Remove
                    </button>
                  )}
                </div>
              ))}

              <button
                type="button"
                className="btn"
                disabled={rows.length >= MAX_ROWS}
                onClick={() => setRows([...rows, { platform: initial.allowedPlatforms[0] ?? "", url: "" }])}
                style={{ marginTop: 4 }}
              >
                + Add another link
              </button>

              {error && (
                <div className="banner" role="alert" style={{ marginTop: 14 }}>
                  {error}
                </div>
              )}

              <div className="formfoot" style={{ margin: "18px -20px -18px", borderRadius: "0 0 12px 12px" }}>
                <small>Server validation is authoritative - platform and URL are re-checked on submit.</small>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || rows.some((r) => !r.platform || !r.url.trim())}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    const result = await submitPublicLinks(token, rows);
                    setBusy(false);
                    if (!result.ok) {
                      if (result.code === "unusable") {
                        setUnavailable(true);
                        return;
                      }
                      setError(result.error);
                      return;
                    }
                    setSubmitted(true);
                  }}
                >
                  {busy ? "Submitting…" : "Submit Links"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <p className="publicfoot">This is a secure, single-use CreatorOps submission link.</p>
    </div>
  );
}
