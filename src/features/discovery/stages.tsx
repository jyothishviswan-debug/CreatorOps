"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { Pill } from "@/ui/Badge";
import { Icon } from "@/ui/icons";
import type { LeadDto } from "@/server/discovery/client-dto";
import type { ManagerCandidateDto } from "@/server/discovery/user-picker";
import { ASSET_DECISIONS, REVIEW_OUTCOMES, TARGET_AUDIENCES, type AssetDecisionKind, type LeadKycAttachment, type ReviewOutcome, type TargetAudience } from "@/server/discovery/types";
import type { DiscoveryApiResult } from "./api-client";
import {
  addKycLinkAttachment,
  assignManager,
  checkLeadDuplicates,
  getLeadKyc,
  recordOutreach,
  recordReview,
  saveAssetDecision,
  saveCommercial,
  saveDiscoveryAgreement,
  saveLeadKyc,
  saveResearch,
  uploadKycAttachment,
} from "./api-client";
import { DuplicateStatusBanner } from "./DuplicateStatus";
import { REVIEW_OUTCOME_LABELS } from "./format";
import { ManagerPicker } from "./ManagerPicker";

type StageProps = { lead: LeadDto; onSaved: (lead: LeadDto) => void };

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="banner" role="alert" style={{ marginTop: 12 }}>
      {message}
    </div>
  );
}

function useSaveHandler(onSaved: (lead: LeadDto) => void) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(call: () => Promise<DiscoveryApiResult<LeadDto>>) {
    setSaving(true);
    setError(null);
    const result = await call();
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    onSaved(result.data);
    return true;
  }

  return { saving, error, run };
}

// ---- Lead ----

export function LeadStage({ lead, onSaved }: StageProps) {
  const { saving, error, run } = useSaveHandler(onSaved);

  return (
    <div>
      <div className="kv">
        <span>Name</span>
        <b>{lead.displayName}</b>
      </div>
      <div className="kv">
        <span>Email</span>
        <b>{lead.email ?? "—"}</b>
      </div>
      <div className="kv">
        <span>Phone</span>
        <b>{lead.phone ?? "—"}</b>
      </div>
      <div className="kv">
        <span>Profile URL</span>
        <b>{lead.profileUrl ? <a href={lead.profileUrl} target="_blank" rel="noreferrer">{lead.profileUrl}</a> : "—"}</b>
      </div>
      <div className="kv">
        <span>Platform / handle</span>
        <b>
          {lead.platform ?? "—"} {lead.handle ? `· @${lead.handle}` : ""}
        </b>
      </div>
      <div className="kv">
        <span>Region / team</span>
        <b>
          {lead.region ?? "—"} {lead.teamId ? `· ${lead.teamId}` : ""}
        </b>
      </div>
      <div className="kv">
        <span>Source</span>
        <b>{lead.source.type}</b>
      </div>

      <div className="actions" style={{ marginTop: 16 }}>
        <Link href={`/discovery/${lead.leadRef}/edit`} className="btn">
          Edit lead
        </Link>
        <button
          type="button"
          className="btn"
          disabled={saving}
          onClick={() => run(() => checkLeadDuplicates(lead.leadRef, lead.version))}
        >
          {saving ? "Checking…" : "Run duplicate check"}
        </button>
      </div>

      <div style={{ marginTop: 14 }}>
        <DuplicateStatusBanner result={lead.duplicateCheck} />
      </div>
      <ErrorBanner message={error} />
    </div>
  );
}

// ---- Research ----

export function ResearchStage({ lead, onSaved }: StageProps) {
  const r = lead.research;
  const [targetAudience, setTargetAudience] = useState<TargetAudience | "">((r?.targetAudience as TargetAudience | null) ?? "");
  const [language, setLanguage] = useState(r?.language ?? "");
  const [location, setLocation] = useState(r?.location ?? "");
  const [category, setCategory] = useState(r?.category ?? "");
  const [notes, setNotes] = useState(r?.notes ?? "");
  const [followerCount, setFollowerCount] = useState(r?.followerCount !== undefined ? String(r.followerCount) : "");
  const { saving, error, run } = useSaveHandler(onSaved);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    await run(() =>
      saveResearch(lead.leadRef, {
        targetAudience: targetAudience || null,
        language: language.trim() || undefined,
        location: location.trim() || undefined,
        category: category.trim() || undefined,
        notes: notes.trim() || undefined,
        followerCount: followerCount.trim() ? Number(followerCount) : undefined,
        expectedVersion: lead.version,
      }),
    );
  }

  return (
    <div>
      {r && (
        <div className="kv">
          <span>Saved Target Audience</span>
          <Pill tone={r.targetAudience ? "default" : "red"}>{r.targetAudience ?? "Not approved"}</Pill>
        </div>
      )}
      <p className="foundationnote">Only Target Audience is mandatory and gates progress. Language, location, category, notes and follower count are optional context.</p>
      <form onSubmit={handleSubmit}>
        <div className="fields">
          <div className="field">
            <label htmlFor="research-target-audience">Target Audience (required)</label>
            <select id="research-target-audience" value={targetAudience} onChange={(e) => setTargetAudience(e.target.value as TargetAudience)} required>
              <option value="">Select…</option>
              {TARGET_AUDIENCES.map((ta) => (
                <option key={ta} value={ta}>
                  {ta}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="research-language">Language (optional)</label>
            <input id="research-language" type="text" value={language} onChange={(e) => setLanguage(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="research-location">Location (optional)</label>
            <input id="research-location" type="text" value={location} onChange={(e) => setLocation(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="research-category">Category / niche (optional)</label>
            <input id="research-category" type="text" value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="research-followers">Follower count (optional)</label>
            <input id="research-followers" type="number" min={0} value={followerCount} onChange={(e) => setFollowerCount(e.target.value)} />
          </div>
          <div className="field full">
            <label htmlFor="research-notes">Notes / observations (optional)</label>
            <textarea id="research-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <ErrorBanner message={error} />
        <button type="submit" className="btn primary" disabled={saving} style={{ marginTop: 14 }}>
          {saving ? "Saving…" : "Save research"}
        </button>
      </form>
    </div>
  );
}

// ---- Review & Shortlist ----

const DIMENSION_FIELDS: { key: keyof NonNullable<LeadDto["latestReview"]>["dimensions"]; label: string }[] = [
  { key: "contentQuality", label: "Content quality" },
  { key: "audienceQuality", label: "Audience quality" },
  { key: "postingConsistency", label: "Posting consistency" },
  { key: "regionalRelevance", label: "Regional relevance" },
  { key: "languageMatch", label: "Language match" },
  { key: "growthPotential", label: "Growth potential" },
  { key: "communication", label: "Communication" },
  { key: "overallConfidence", label: "Overall confidence" },
];

export function ReviewStage({ lead, onSaved }: StageProps) {
  const latest = lead.latestReview;
  const [outcome, setOutcome] = useState<ReviewOutcome>(latest?.outcome ?? "SHORTLIST");
  const [dimensions, setDimensions] = useState<Record<string, number | "">>(() => {
    const initial: Record<string, number | ""> = {};
    for (const field of DIMENSION_FIELDS) initial[field.key] = latest?.dimensions[field.key] ?? "";
    return initial;
  });
  const [reason, setReason] = useState(latest?.reason ?? "");
  const { saving, error, run } = useSaveHandler(onSaved);

  const reasonRequired = outcome !== "SHORTLIST";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (reasonRequired && !reason.trim()) return;
    const dims: Record<string, number> = {};
    for (const [key, value] of Object.entries(dimensions)) if (value !== "") dims[key] = value;
    await run(() => recordReview(lead.leadRef, { outcome, dimensions: dims, reason: reason.trim() || undefined, expectedVersion: lead.version }));
  }

  return (
    <div>
      {latest && (
        <div className="kv">
          <span>Latest outcome</span>
          <Pill tone={latest.outcome === "SHORTLIST" ? "default" : latest.outcome === "REJECT" ? "red" : "orange"}>{REVIEW_OUTCOME_LABELS[latest.outcome]}</Pill>
        </div>
      )}
      <form onSubmit={handleSubmit}>
        <div className="fields">
          {DIMENSION_FIELDS.map((field) => (
            <div className="field" key={field.key}>
              <label htmlFor={`review-${field.key}`}>{field.label}</label>
              <select
                id={`review-${field.key}`}
                value={dimensions[field.key]}
                onChange={(e) => setDimensions((prev) => ({ ...prev, [field.key]: e.target.value ? Number(e.target.value) : "" }))}
              >
                <option value="">Not rated</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <div className="field">
            <label htmlFor="review-outcome">Outcome</label>
            <select id="review-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as ReviewOutcome)}>
              {REVIEW_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {REVIEW_OUTCOME_LABELS[o]}
                </option>
              ))}
            </select>
          </div>
          <div className="field full">
            <label htmlFor="review-reason">Reason / note {reasonRequired ? "(required)" : "(optional)"}</label>
            <textarea id="review-reason" value={reason} onChange={(e) => setReason(e.target.value)} required={reasonRequired} />
          </div>
        </div>
        <ErrorBanner message={error} />
        <button type="submit" className="btn primary" disabled={saving} style={{ marginTop: 14 }}>
          {saving ? "Saving…" : "Save review"}
        </button>
      </form>
    </div>
  );
}

// ---- Outreach & Negotiation ----

export function OutreachStage({ lead, onSaved }: StageProps) {
  const [direction, setDirection] = useState<"OUTBOUND" | "INBOUND">("OUTBOUND");
  const [channel, setChannel] = useState("");
  const [summary, setSummary] = useState("");
  const [outcome, setOutcome] = useState("");
  const [notes, setNotes] = useState("");
  const [supportingReference, setSupportingReference] = useState("");
  const [nextFollowUpAt, setNextFollowUpAt] = useState("");
  const [meaningfulResponse, setMeaningfulResponse] = useState(false);
  const outreachSave = useSaveHandler(onSaved);

  const [negotiationSummary, setNegotiationSummary] = useState(lead.commercial?.negotiationSummary ?? "");
  const [alignmentConfirmed, setAlignmentConfirmed] = useState(lead.commercial?.alignmentConfirmed ?? false);
  const commercialSave = useSaveHandler(onSaved);

  async function handleOutreachSubmit(e: FormEvent) {
    e.preventDefault();
    const ok = await outreachSave.run(() =>
      recordOutreach(lead.leadRef, {
        direction,
        channel,
        summary,
        outcome,
        notes: notes.trim() || undefined,
        supportingReference: supportingReference.trim() || undefined,
        nextFollowUpAt: nextFollowUpAt || undefined,
        meaningfulResponse: direction === "INBOUND" ? meaningfulResponse : undefined,
        expectedVersion: lead.version,
      }),
    );
    if (ok) {
      setChannel("");
      setSummary("");
      setOutcome("");
      setNotes("");
      setSupportingReference("");
      setNextFollowUpAt("");
      setMeaningfulResponse(false);
    }
  }

  async function handleCommercialSubmit(e: FormEvent) {
    e.preventDefault();
    await commercialSave.run(() => saveCommercial(lead.leadRef, { negotiationSummary: negotiationSummary.trim() || undefined, alignmentConfirmed, expectedVersion: lead.version }));
  }

  return (
    <div>
      <h3>Outreach</h3>
      {lead.outreachSummary && (
        <>
          <div className="kv">
            <span>Attempts logged</span>
            <b>{lead.outreachSummary.totalCount}</b>
          </div>
          <div className="kv">
            <span>Last contact</span>
            <b>
              {lead.outreachSummary.lastDirection === "OUTBOUND" ? "Outbound" : "Inbound"} · {lead.outreachSummary.lastChannel} · {lead.outreachSummary.lastOutcome}
            </b>
          </div>
          {lead.respondedAt && (
            <div className="kv">
              <span>Meaningful response recorded</span>
              <b>Yes</b>
            </div>
          )}
        </>
      )}
      <p className="foundationnote">The contact timestamp is always server-captured - never entered by the operator.</p>
      <form onSubmit={handleOutreachSubmit}>
        <div className="fields">
          <div className="field">
            <label htmlFor="outreach-direction">Direction</label>
            <select id="outreach-direction" value={direction} onChange={(e) => setDirection(e.target.value as "OUTBOUND" | "INBOUND")}>
              <option value="OUTBOUND">Outbound</option>
              <option value="INBOUND">Inbound</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="outreach-channel">Channel</label>
            <input id="outreach-channel" type="text" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="email, call, DM…" required />
          </div>
          <div className="field full">
            <label htmlFor="outreach-summary">Summary</label>
            <textarea id="outreach-summary" value={summary} onChange={(e) => setSummary(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="outreach-outcome">Outcome</label>
            <input id="outreach-outcome" type="text" value={outcome} onChange={(e) => setOutcome(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="outreach-followup">Next follow-up date</label>
            <input id="outreach-followup" type="date" value={nextFollowUpAt} onChange={(e) => setNextFollowUpAt(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="outreach-reference">Supporting reference</label>
            <input id="outreach-reference" type="text" value={supportingReference} onChange={(e) => setSupportingReference(e.target.value)} />
          </div>
          <div className="field full">
            <label htmlFor="outreach-notes">Notes</label>
            <textarea id="outreach-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {direction === "INBOUND" && (
            <div className="field">
              <label htmlFor="outreach-meaningful">
                <input id="outreach-meaningful" type="checkbox" checked={meaningfulResponse} onChange={(e) => setMeaningfulResponse(e.target.checked)} style={{ marginRight: 8 }} />
                This is a meaningful response
              </label>
            </div>
          )}
        </div>
        <ErrorBanner message={outreachSave.error} />
        <button type="submit" className="btn primary" disabled={outreachSave.saving} style={{ marginTop: 14 }}>
          {outreachSave.saving ? "Recording…" : "Record outreach"}
        </button>
      </form>

      <h3 style={{ marginTop: 28 }}>Negotiation / commercial alignment</h3>
      <p className="foundationnote">Distinct evidence from outreach above - conversion evidence, not a contact log entry.</p>
      <form onSubmit={handleCommercialSubmit}>
        <div className="fields">
          <div className="field full">
            <label htmlFor="commercial-summary">Negotiation summary</label>
            <textarea id="commercial-summary" value={negotiationSummary} onChange={(e) => setNegotiationSummary(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="commercial-confirmed">
              <input id="commercial-confirmed" type="checkbox" checked={alignmentConfirmed} onChange={(e) => setAlignmentConfirmed(e.target.checked)} style={{ marginRight: 8 }} />
              Commercial alignment confirmed
            </label>
          </div>
        </div>
        <ErrorBanner message={commercialSave.error} />
        <button type="submit" className="btn primary" disabled={commercialSave.saving} style={{ marginTop: 14 }}>
          {commercialSave.saving ? "Saving…" : "Save commercial evidence"}
        </button>
      </form>
    </div>
  );
}

// ---- Agreement ----

export function AgreementStage({ lead, onSaved }: StageProps) {
  const a = lead.discoveryAgreement;
  const [summary, setSummary] = useState(a?.summary ?? "");
  const [amount, setAmount] = useState(a?.amount !== undefined ? String(a.amount) : "");
  const [deliverableCount, setDeliverableCount] = useState(a?.deliverableCount !== undefined ? String(a.deliverableCount) : "");
  const [referenceUrl, setReferenceUrl] = useState(a?.referenceUrl ?? "");
  const [confirmed, setConfirmed] = useState(Boolean(a?.confirmedAt));
  const { saving, error, run } = useSaveHandler(onSaved);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    await run(() =>
      saveDiscoveryAgreement(lead.leadRef, {
        summary: summary.trim() || undefined,
        amount: amount.trim() ? Number(amount) : undefined,
        deliverableCount: deliverableCount.trim() ? Number(deliverableCount) : undefined,
        referenceUrl: referenceUrl.trim() || undefined,
        confirmed,
        expectedVersion: lead.version,
      }),
    );
  }

  return (
    <div>
      <p className="foundationnote">
        <b>Discovery operational agreement evidence only.</b> This is never canonical Finance Agreement truth.
      </p>
      {a && (
        <>
          <div className="kv">
            <span>Confirmed</span>
            <Pill tone={a.confirmedAt ? "default" : "gray"}>{a.confirmedAt ? "Yes" : "Not yet"}</Pill>
          </div>
          {a.amount !== undefined && (
            <div className="kv">
              <span>Amount</span>
              <b>{a.amount.toLocaleString()}</b>
            </div>
          )}
          {a.deliverableCount !== undefined && (
            <div className="kv">
              <span>Deliverables</span>
              <b>{a.deliverableCount}</b>
            </div>
          )}
        </>
      )}
      <form onSubmit={handleSubmit}>
        <div className="fields">
          <div className="field full">
            <label htmlFor="agreement-summary">Summary note</label>
            <textarea id="agreement-summary" value={summary} onChange={(e) => setSummary(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="agreement-amount">Amount</label>
            <input id="agreement-amount" type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="agreement-deliverable-count">Deliverable count</label>
            <input id="agreement-deliverable-count" type="number" min={0} step="1" value={deliverableCount} onChange={(e) => setDeliverableCount(e.target.value)} />
          </div>
          <div className="field full">
            <label htmlFor="agreement-reference">Reference URL</label>
            <input id="agreement-reference" type="url" value={referenceUrl} onChange={(e) => setReferenceUrl(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="agreement-confirmed">
              <input id="agreement-confirmed" type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ marginRight: 8 }} />
              Operational agreement confirmed
            </label>
          </div>
        </div>
        <ErrorBanner message={error} />
        <button type="submit" className="btn primary" disabled={saving} style={{ marginTop: 14 }}>
          {saving ? "Saving…" : "Save agreement evidence"}
        </button>
      </form>
    </div>
  );
}

// ---- Asset Setup ----

const ASSET_LABELS: Record<AssetDecisionKind, string> = {
  MAINTAIN_EXISTING: "Maintain Existing",
  TRANSFER_AND_MAINTAIN: "Transfer & Maintain",
  NEW_ACCOUNT: "New Account",
};

export function AssetStage({ lead, onSaved }: StageProps) {
  const d = lead.assetDecision;
  const [decision, setDecision] = useState<AssetDecisionKind>(d?.decision ?? "NEW_ACCOUNT");
  const [existingRef, setExistingRef] = useState(d?.existingPartnerAccountRef ?? "");
  const [notes, setNotes] = useState(d?.notes ?? "");
  const { saving, error, run } = useSaveHandler(onSaved);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    await run(() =>
      saveAssetDecision(lead.leadRef, {
        decision,
        existingPartnerAccountRef: decision !== "NEW_ACCOUNT" ? existingRef.trim() : undefined,
        notes: notes.trim() || undefined,
        expectedVersion: lead.version,
      }),
    );
  }

  return (
    <div>
      {d && (
        <div className="kv">
          <span>Saved decision</span>
          <Pill tone="default">{ASSET_LABELS[d.decision]}</Pill>
        </div>
      )}
      {decision === "NEW_ACCOUNT" && (
        <div className="banner" role="status">
          <b>New Account setup is pending.</b> No Partner Account URL or handle is fabricated - it&rsquo;s created only once conversion completes, and only from confirmed evidence.
        </div>
      )}
      <form onSubmit={handleSubmit}>
        <div className="fields">
          <div className="field full">
            <label htmlFor="asset-decision">Decision</label>
            <select id="asset-decision" value={decision} onChange={(e) => setDecision(e.target.value as AssetDecisionKind)}>
              {ASSET_DECISIONS.map((k) => (
                <option key={k} value={k}>
                  {ASSET_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          {decision !== "NEW_ACCOUNT" && (
            <div className="field full">
              <label htmlFor="asset-existing-ref">Existing Partner Account reference</label>
              <input id="asset-existing-ref" type="text" value={existingRef} onChange={(e) => setExistingRef(e.target.value)} required />
            </div>
          )}
          <div className="field full">
            <label htmlFor="asset-notes">Notes</label>
            <textarea id="asset-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <ErrorBanner message={error} />
        <button type="submit" className="btn primary" disabled={saving} style={{ marginTop: 14 }}>
          {saving ? "Saving…" : "Save asset decision"}
        </button>
      </form>
    </div>
  );
}

// ---- Manager ----
// Its own section, paired with Alternative Outcomes as a 1x2 row (see
// DiscoveryLeadDetail.tsx) - deliberately separate from KYC below,
// which needs the full panel width for its own multi-field form.

export function ManagerStage({ lead, onSaved }: StageProps) {
  const managerSave = useSaveHandler(onSaved);
  // window.confirm() proved unreliable here (silently does nothing in
  // some embedded browser contexts) - a plain inline Cancel/Confirm
  // pair, the same idiom AlternativeOutcomes already uses for its own
  // set-aside actions, works everywhere instead.
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  async function handleAssign(candidate: ManagerCandidateDto) {
    await managerSave.run(() => assignManager(lead.leadRef, { managerUserRef: candidate.userRef, expectedVersion: lead.version }));
  }
  async function handleClear() {
    const ok = await managerSave.run(() => assignManager(lead.leadRef, { managerUserRef: null, expectedVersion: lead.version }));
    if (ok) setConfirmingRemove(false);
  }

  return (
    <div>
      {!lead.managerRef && <ManagerPicker onSelect={handleAssign} />}
      <div className="kv" style={{ borderBottom: "none", marginTop: lead.managerRef ? 0 : 12 }}>
        <span>Assigned manager</span>
        <b>{lead.managerDisplayName ?? "Unassigned"}</b>
      </div>
      {lead.managerRef &&
        (confirmingRemove ? (
          <div className="actions" style={{ marginTop: 10 }}>
            <small>Remove the assigned manager?</small>
            <button type="button" className="btn" disabled={managerSave.saving} onClick={() => setConfirmingRemove(false)}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={managerSave.saving} onClick={handleClear}>
              {managerSave.saving ? "Removing…" : "Confirm"}
            </button>
          </div>
        ) : (
          <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => setConfirmingRemove(true)}>
            Remove manager
          </button>
        ))}
      <ErrorBanner message={managerSave.error} />
    </div>
  );
}

// ---- Restricted KYC ----
// Its own full-width section (see DiscoveryLeadDetail.tsx) - the form
// below has 11+ fields plus a document-attachments manager, which needs
// the full panel width, not a half-width column shared with Manager.

export function KycStage({ lead, onSaved }: StageProps) {
  return <KycPanel lead={lead} onSaved={onSaved} />;
}

function KycPanel({ lead, onSaved }: StageProps) {
  const [state, setState] = useState<"idle" | "loading" | "denied" | "error" | "ready">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [aadhaarNumber, setAadhaarNumber] = useState("");
  const [panNumber, setPanNumber] = useState("");
  const [accountHolderName, setAccountHolderName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [bankName, setBankName] = useState("");
  const [gstApplicable, setGstApplicable] = useState(false);
  const [gstNumber, setGstNumber] = useState("");
  const [existingKycVersion, setExistingKycVersion] = useState(0);
  const [attachments, setAttachments] = useState<LeadKycAttachment[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function load() {
    setState("loading");
    setErrorMessage(null);
    const result = await getLeadKyc(lead.leadRef);
    if (!result.ok) {
      if (result.code === "unauthorized") {
        setState("denied");
        setErrorMessage(result.error);
        return;
      }
      setState("error");
      setErrorMessage(result.error);
      return;
    }
    setState("ready");
    if (result.data) {
      setEmail(result.data.email);
      setAadhaarNumber(result.data.aadhaar.number);
      setPanNumber(result.data.pan.number);
      setAccountHolderName(result.data.bank.accountHolderName);
      setAccountNumber(result.data.bank.accountNumber);
      setIfsc(result.data.bank.ifsc);
      setBankName(result.data.bank.bankName);
      setGstApplicable(result.data.gst.applicable);
      setGstNumber(result.data.gst.number ?? "");
      setExistingKycVersion(result.data.version);
      setAttachments(result.data.attachments);
    }
  }

  if (state === "idle") {
    return (
      <button type="button" className="btn" onClick={load}>
        View / manage restricted KYC
      </button>
    );
  }
  if (state === "loading") return <p className="foundationnote">Loading…</p>;
  if (state === "denied") {
    return (
      <div className="banner" role="alert">
        <b>Restricted.</b> {errorMessage ?? "This KYC package requires the discovery_kyc sensitive-access category."}
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="banner" role="alert">
        <b>Couldn&rsquo;t load KYC.</b> {errorMessage}
        <button type="button" className="btn" style={{ marginLeft: 10 }} onClick={load}>
          Retry
        </button>
      </div>
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (gstApplicable && !gstNumber.trim()) {
      setSaveError("GST number is required when GST is applicable.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    const result = await saveLeadKyc(lead.leadRef, {
      email,
      aadhaar: { number: aadhaarNumber },
      pan: { number: panNumber },
      bank: { accountHolderName, accountNumber, ifsc, bankName },
      gst: { applicable: gstApplicable, number: gstApplicable ? gstNumber.trim() : undefined },
      expectedKycVersion: existingKycVersion,
      expectedLeadVersion: lead.version,
    });
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.error);
      return;
    }
    setExistingKycVersion(result.data.version);
    onSaved({ ...lead, kycPackageComplete: true, version: lead.version + 1 });
  }

  return (
    <>
    <form onSubmit={handleSubmit}>
      <p className="foundationnote">No postal address or address proof is collected. Save the identifiers below, then add each document as a real Drive-backed link or upload in the attachments panel.</p>
      <div className="fields">
        <div className="field">
          <label htmlFor="kyc-email">Email</label>
          <input id="kyc-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="kyc-aadhaar">Aadhaar number</label>
          <input id="kyc-aadhaar" type="text" value={aadhaarNumber} onChange={(e) => setAadhaarNumber(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="kyc-pan">PAN</label>
          <input id="kyc-pan" type="text" value={panNumber} onChange={(e) => setPanNumber(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="kyc-account-holder">Account holder name</label>
          <input id="kyc-account-holder" type="text" value={accountHolderName} onChange={(e) => setAccountHolderName(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="kyc-account-number">Account number</label>
          <input id="kyc-account-number" type="text" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="kyc-ifsc">IFSC</label>
          <input id="kyc-ifsc" type="text" value={ifsc} onChange={(e) => setIfsc(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="kyc-bank-name">Bank name</label>
          <input id="kyc-bank-name" type="text" value={bankName} onChange={(e) => setBankName(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="kyc-gst-applicable">
            <input id="kyc-gst-applicable" type="checkbox" checked={gstApplicable} onChange={(e) => setGstApplicable(e.target.checked)} style={{ marginRight: 8 }} />
            GST applicable
          </label>
        </div>
        {gstApplicable && (
          <div className="field full">
            <label htmlFor="kyc-gst-number">GST number</label>
            <input id="kyc-gst-number" type="text" value={gstNumber} onChange={(e) => setGstNumber(e.target.value)} required />
          </div>
        )}
      </div>
      <ErrorBanner message={saveError} />
      <button type="submit" className="btn primary" disabled={saving} style={{ marginTop: 14 }}>
        {saving ? "Saving…" : "Save KYC package"}
      </button>
      </form>
      {existingKycVersion > 0 ? (
        <KycAttachments leadRef={lead.leadRef} version={existingKycVersion} attachments={attachments} onChanged={(version, next) => {
          setExistingKycVersion(version);
          setAttachments(next);
        }} />
      ) : (
        <p className="foundationnote" style={{ marginTop: 18 }}>
          Save the KYC package above before adding document links or uploads.
        </p>
      )}
    </>
  );
}

const DOC_TYPE_LABELS: Record<LeadKycAttachment["docType"], string> = {
  aadhaar: "Aadhaar",
  pan: "PAN",
  bank: "Bank proof",
  gst: "GST certificate",
  other: "Other",
};
const DOC_TYPES = Object.keys(DOC_TYPE_LABELS) as LeadKycAttachment["docType"][];

// Step 6B.1: a supplementary attachment manager, additional to (never a
// replacement for) the plain evidence-reference text fields in the form
// above. One document at a time: pick its type, choose link or upload,
// submit - real uploads land in the Lead's own Drive subfolder (named
// from its proposal number, allocated when Agreement was confirmed) and
// only the real Drive link Drive returns is ever stored.
function KycAttachments({
  leadRef,
  version,
  attachments,
  onChanged,
}: {
  leadRef: string;
  version: number;
  attachments: LeadKycAttachment[];
  onChanged: (version: number, attachments: LeadKycAttachment[]) => void;
}) {
  const [docType, setDocType] = useState<LeadKycAttachment["docType"]>("aadhaar");
  const [mode, setMode] = useState<"link" | "upload">("link");
  const [linkUrl, setLinkUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (mode === "link") {
      if (!linkUrl.trim()) return;
      setBusy(true);
      const result = await addKycLinkAttachment(leadRef, { docType, url: linkUrl.trim(), expectedKycVersion: version });
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLinkUrl("");
      onChanged(result.data.version, [...attachments, result.data.attachment]);
      return;
    }

    if (!file) return;
    setBusy(true);
    const result = await uploadKycAttachment(leadRef, { docType, file, expectedKycVersion: version });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setFile(null);
    onChanged(result.data.version, [...attachments, result.data.attachment]);
  }

  return (
    <div style={{ marginTop: 28 }}>
      <h3>Document attachments</h3>
      <p className="foundationnote">Add a link to an existing document, or upload a real file - uploads are stored in this Lead&rsquo;s own Drive folder, never simulated.</p>

      <form onSubmit={handleAdd}>
        <div className="fields">
          <div className="field">
            <label htmlFor="attach-doc-type">Document name</label>
            <select id="attach-doc-type" value={docType} onChange={(e) => setDocType(e.target.value as LeadKycAttachment["docType"])}>
              {DOC_TYPES.map((type) => (
                <option key={type} value={type}>
                  {DOC_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="attach-mode">Source</label>
            <select id="attach-mode" value={mode} onChange={(e) => setMode(e.target.value as "link" | "upload")}>
              <option value="link">Doc link</option>
              <option value="upload">Upload file</option>
            </select>
          </div>
          {mode === "link" ? (
            <div className="field full" key="link">
              <label htmlFor="attach-url">Document link</label>
              <input id="attach-url" type="url" placeholder="https://…" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} required />
            </div>
          ) : (
            <div className="field full" key="upload">
              <label htmlFor="attach-file">Choose file</label>
              <input id="attach-file" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
            </div>
          )}
        </div>
        <ErrorBanner message={error} />
        <button type="submit" className="btn" disabled={busy} style={{ marginTop: 12 }}>
          <Icon name="upload" /> {busy ? "Adding…" : mode === "link" ? "Add link" : "Upload"}
        </button>
      </form>

      {attachments.length > 0 && (
        // Fills the panel's full width instead of one entry per row -
        // this panel is already full-width (see DiscoveryLeadDetail.tsx),
        // no reason a short attachment list should scroll tall when
        // several entries comfortably fit side by side.
        <ul className="checklist" style={{ marginTop: 18, gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
          {attachments.map((a, i) => (
            <li key={`${a.docType}-${a.addedAt}-${i}`}>
              <Icon name={a.kind === "upload" ? "upload" : "link"} />
              <b>{DOC_TYPE_LABELS[a.docType]}</b> ·{" "}
              <a href={a.url} target="_blank" rel="noreferrer">
                {a.kind === "upload" ? a.fileName ?? "Uploaded file" : "Open link"}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
