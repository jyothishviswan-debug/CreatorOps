"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import Link from "next/link";

import { DialogShell } from "@/ui/Dialog";
import { SearchInput } from "@/ui/Table";
import type { AssignmentOptionAccount, AssignmentOptionPartner, AssignmentOptionsCampaignContext, AssignmentOptionsSelectedPartner } from "@/server/campaigns/assignment-options-service";
import { createAssignment } from "@/features/assignments/api-client";
import { STATUS_LABELS as ASSIGNMENT_STATUS_LABELS } from "@/features/assignments/format";
import { getAssignmentCreateOptions } from "./api-client";
import { buildCreateAssignmentInput, EMPTY_CREATE_ASSIGNMENT_FORM, LIMITS, type CreateAssignmentFormValues } from "./create-assignment-form";
import { dateLabel } from "./format";

const SEARCH_DEBOUNCE_MS = 250;

// Step 12C.2: the visibly-disabled treatment for THIS dialog's footer
// buttons only. There is deliberately no global `.btn:disabled` rule (other
// screens rely on today's look), so the treatment is applied locally, as an
// inline style, only while a footer button is `disabled`. Native `disabled`
// semantics are unchanged. Inline `background` also beats the stylesheet's
// `.btn:hover` / `.btn.primary:hover` rules (no !important needed), so a
// disabled button shows no hover/active treatment, and `not-allowed` replaces
// any action cursor. Colors: #5a6572 on #eceff2 = 5.14:1 contrast (>= 4.5:1).
const DISABLED_FOOTER_BUTTON_STYLE: CSSProperties = { background: "#eceff2", borderColor: "#d5dae0", color: "#5a6572", cursor: "not-allowed" };

type CreateResult = { kind: "created"; assignmentRef: string } | { kind: "existing"; assignmentRef: string | null };

// Step 12C.1: the contextual "Create Assignment" focused action on Campaign
// Detail - the accepted DialogShell (native <dialog>: focus trap, Esc,
// focus restore), never a new page/tab/panel. The Campaign is FIXED by the
// `campaignRef` prop (the route context); the dialog has no Campaign
// selector and the trusted server re-loads and re-authorizes the Campaign
// on every request. Partner and Partner Account choices come exclusively
// from the trusted, bounded GET .../assignment-options endpoint - never a
// browser-side fetch-all - and the final write is the already-accepted
// POST /api/assignments, which re-validates every choice independently.
//
// Deliberately absent (Step 12C.1 boundaries): any owner field (the backend
// snapshots owner/regions/teams from the Campaign, so an Assignment has no
// separately-settable owner), review policy, Finance/commercial terms,
// Target Audience, analytics targets, and any call that would issue/accept
// the Assignment, create Content, mint a public token/session or open
// WhatsApp - creation only ever produces a DRAFT.
export function CreateAssignmentDialog({ campaignRef, onClose }: { campaignRef: string; onClose: (changed: boolean) => void }) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;

  const [context, setContext] = useState<AssignmentOptionsCampaignContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [partners, setPartners] = useState<AssignmentOptionPartner[]>([]);
  const [hasMorePartners, setHasMorePartners] = useState(false);
  const [searching, setSearching] = useState(true);

  const [partner, setPartner] = useState<AssignmentOptionPartner | null>(null);
  const [partnerDetail, setPartnerDetail] = useState<AssignmentOptionsSelectedPartner | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedAccountRefs, setSelectedAccountRefs] = useState<string[]>([]);

  const [values, setValues] = useState<CreateAssignmentFormValues>(EMPTY_CREATE_ASSIGNMENT_FORM);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [conflictNoLink, setConflictNoLink] = useState(false);

  const detailToken = useRef(0);
  const submittingRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // Debounced, abortable Partner search. `q` may be empty - the server then
  // returns its own bounded default page (max 10 ACTIVE Partners). Every
  // setState happens inside the timer/async callback, never synchronously
  // in the effect body.
  useEffect(() => {
    if (partner) return;
    const controller = new AbortController();
    const timeout = setTimeout(
      async () => {
        setSearching(true);
        const response = await getAssignmentCreateOptions(campaignRef, { q: query.trim() }, controller.signal);
        if (controller.signal.aborted) return;
        setSearching(false);
        if (!response.ok) {
          setLoadError(response.error);
          return;
        }
        setLoadError(null);
        setContext(response.data.campaign);
        setPartners(response.data.partners);
        setHasMorePartners(response.data.hasMorePartners);
      },
      query.length === 0 ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [query, partner, campaignRef]);

  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);

  async function choosePartner(next: AssignmentOptionPartner) {
    const token = (detailToken.current += 1);
    setPartner(next);
    setPartnerDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    setSelectedAccountRefs([]);
    setFormErrors([]);
    setSubmitError(null);
    const response = await getAssignmentCreateOptions(campaignRef, { partnerRef: next.partnerRef });
    if (token !== detailToken.current) return;
    setDetailLoading(false);
    if (!response.ok || !response.data.selectedPartner) {
      setDetailError(response.ok ? "Could not load this Partner's accounts." : response.error);
      return;
    }
    const detail = response.data.selectedPartner;
    setPartnerDetail(detail);
    const selectable = detail.accounts.filter((account) => account.selectable);
    // Convenience only: with exactly one compatible account there is
    // nothing to choose between. The user can still untick it.
    if (selectable.length === 1) setSelectedAccountRefs([selectable[0]!.partnerAccountRef]);
  }

  function changePartner() {
    detailToken.current += 1;
    setPartner(null);
    setPartnerDetail(null);
    setDetailError(null);
    setDetailLoading(false);
    setSelectedAccountRefs([]);
    setFormErrors([]);
    setSubmitError(null);
    setConflictNoLink(false);
    setQuery("");
  }

  function toggleAccount(account: AssignmentOptionAccount, checked: boolean) {
    setSelectedAccountRefs((current) => (checked ? [...new Set([...current, account.partnerAccountRef])] : current.filter((ref) => ref !== account.partnerAccountRef)));
  }

  function setValue<K extends keyof CreateAssignmentFormValues>(key: K, value: CreateAssignmentFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      listRef.current?.querySelector("button")?.focus();
    }
  }

  function onResultsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...(listRef.current?.querySelectorAll("button") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    event.preventDefault();
    if (event.key === "ArrowDown") buttons[Math.min(index + 1, buttons.length - 1)]?.focus();
    else if (index === 0) document.getElementById(id("partner-search"))?.focus();
    else buttons[index - 1]?.focus();
  }

  const existing = partnerDetail?.existingAssignment ?? null;
  const selectedAccounts = (partnerDetail?.accounts ?? []).filter((account) => account.selectable && selectedAccountRefs.includes(account.partnerAccountRef));
  const canSubmit = Boolean(partner && partnerDetail && !existing && selectedAccounts.length > 0 && !submitting && !result);

  async function submit() {
    if (submittingRef.current || !partner || !partnerDetail || existing) return;
    const built = buildCreateAssignmentInput({ campaignRef, partnerRef: partner.partnerRef, selectedAccounts, values });
    if (!built.ok) {
      setFormErrors(built.errors);
      return;
    }
    setFormErrors([]);
    setSubmitError(null);
    submittingRef.current = true;
    setSubmitting(true);
    const response = await createAssignment(built.input);
    submittingRef.current = false;
    setSubmitting(false);
    if (!response.ok) {
      // 409 = the permanent (Campaign, Partner) claim exists but the
      // existing Assignment is outside this actor's own Assignment scope:
      // still a safe "already exists" conflict, just without a link.
      if (response.status === 409) {
        setConflictNoLink(true);
        setResult({ kind: "existing", assignmentRef: null });
        return;
      }
      setSubmitError(response.error);
      return;
    }
    setResult(response.data.outcome === "created" ? { kind: "created", assignmentRef: response.data.assignment.assignmentRef } : { kind: "existing", assignmentRef: response.data.assignment.assignmentRef });
  }

  const handleClose = () => onClose(result !== null);

  const footer = result ? (
    <button type="button" className="btn primary" onClick={handleClose}>
      Done
    </button>
  ) : (
    <>
      <button type="button" className="btn" onClick={handleClose} disabled={submitting} style={submitting ? DISABLED_FOOTER_BUTTON_STYLE : undefined}>
        Cancel
      </button>
      <button type="button" className="btn primary" onClick={() => void submit()} disabled={!canSubmit} style={canSubmit ? undefined : DISABLED_FOOTER_BUTTON_STYLE}>
        {submitting ? "Creating…" : "Create Assignment"}
      </button>
    </>
  );

  return (
    <DialogShell open title="Create Assignment" onClose={handleClose} footer={footer}>
      {loadError && !context && (
        <div className="banner" role="alert">
          {loadError}
        </div>
      )}

      {!context && !loadError && (
        <p role="status" aria-live="polite">
          Loading…
        </p>
      )}

      {context && (
        <>
          <div>
            <div className="kv">
              <span>Campaign</span>
              <span>{context.name}</span>
            </div>
            <div className="kv">
              <span>Platforms</span>
              <span>{context.platforms.length > 0 ? context.platforms.map((p) => p.platformLabel).join(", ") : "—"}</span>
            </div>
            <div className="kv">
              <span>Regions</span>
              <span>{context.regionIds.length > 0 ? context.regionIds.join(", ") : "—"}</span>
            </div>
            <div className="kv">
              <span>Dates</span>
              <span>
                {dateLabel(context.startDate)} – {dateLabel(context.endDate)}
              </span>
            </div>
            <div className="kv">
              <span>Objective</span>
              <span>{context.objective}</span>
            </div>
          </div>

          {result?.kind === "created" && (
            <div ref={resultRef} tabIndex={-1} role="status" className="banner" style={{ marginTop: 16, marginBottom: 0, flexWrap: "wrap" }}>
              <b>Assignment created as Draft — it has not been issued.</b>
              <Link href={`/assignments/${encodeURIComponent(result.assignmentRef)}`} className="btn primary">
                Open Assignment
              </Link>
            </div>
          )}

          {result?.kind === "existing" && (
            <div ref={resultRef} tabIndex={-1} role="status" className="banner" style={{ marginTop: 16, marginBottom: 0, flexWrap: "wrap" }}>
              <b>An Assignment already exists for this Partner and Campaign.</b>
              {result.assignmentRef && !conflictNoLink && (
                <Link href={`/assignments/${encodeURIComponent(result.assignmentRef)}`} className="btn">
                  Open existing Assignment
                </Link>
              )}
            </div>
          )}

          {!result && (
            <div style={{ marginTop: 16 }}>
              <div className="field full">
                <label htmlFor={id("partner-search")}>Partner</label>
                {partner ? (
                  <div className="banner" style={{ marginBottom: 0 }}>
                    <span>
                      <b>{partner.displayName}</b>
                      {partner.regionLabels.length > 0 && <small> · {partner.regionLabels.join(", ")}</small>}
                    </span>
                    <button type="button" className="btn" onClick={changePartner} aria-label={`Change Partner ${partner.displayName}`}>
                      Change
                    </button>
                  </div>
                ) : (
                  <>
                    <SearchInput id={id("partner-search")} placeholder="Search Partners by name…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onSearchKeyDown} autoComplete="off" />
                    {searching && (
                      <small role="status" aria-live="polite">
                        Searching Partners…
                      </small>
                    )}
                    {loadError && context && (
                      <div className="banner" role="alert" style={{ marginTop: 8, marginBottom: 0 }}>
                        {loadError}
                      </div>
                    )}
                    {!searching && !loadError && partners.length === 0 && (
                      <small role="status">{query.trim() ? `No active Partners match “${query.trim()}”.` : "No active Partners are available to you."}</small>
                    )}
                    {partners.length > 0 && (
                      <div className="searchresults" style={{ marginTop: 6 }} ref={listRef} onKeyDown={onResultsKeyDown} role="group" aria-label="Partner results">
                        {partners.map((candidate) => (
                          <button key={candidate.partnerRef} type="button" onClick={() => void choosePartner(candidate)}>
                            <b>{candidate.displayName}</b>
                            {candidate.regionLabels.length > 0 && (
                              <>
                                <br />
                                <small>{candidate.regionLabels.join(", ")}</small>
                              </>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                    {hasMorePartners && !searching && <small>Showing the first {partners.length} Partners — type to narrow the search.</small>}
                  </>
                )}
              </div>

              {partner && detailLoading && (
                <p role="status" aria-live="polite" style={{ marginTop: 12 }}>
                  Loading Partner Accounts…
                </p>
              )}
              {partner && detailError && (
                <div className="banner" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
                  {detailError}
                </div>
              )}

              {partnerDetail && existing && (
                <div className="banner" role="status" style={{ marginTop: 12, marginBottom: 0, flexWrap: "wrap" }}>
                  <span>
                    <b>An Assignment already exists for this Partner and Campaign.</b>
                    {existing.status && <small> It is currently {ASSIGNMENT_STATUS_LABELS[existing.status]}.</small>}
                  </span>
                  {existing.canOpen && existing.assignmentRef && (
                    <Link href={`/assignments/${encodeURIComponent(existing.assignmentRef)}`} className="btn">
                      Open existing Assignment
                    </Link>
                  )}
                </div>
              )}

              {partnerDetail && !existing && (
                <>
                  <fieldset className="field full" style={{ border: 0, padding: 0, margin: "16px 0 0" }}>
                    <legend style={{ fontSize: 11, fontWeight: 550, padding: 0, marginBottom: 6 }}>Partner Accounts</legend>
                    {partnerDetail.accounts.length === 0 && (
                      <div className="banner" role="status" style={{ marginBottom: 0, flexWrap: "wrap" }}>
                        <span>This Partner has no Partner Accounts yet, so an Assignment cannot be created for them.</span>
                        <Link href={`/partners/${encodeURIComponent(partnerDetail.partnerRef)}`} className="btn">
                          Open Partner record
                        </Link>
                      </div>
                    )}
                    {partnerDetail.accounts.length > 0 && !partnerDetail.accounts.some((account) => account.selectable) && (
                      <div className="banner" role="status" style={{ marginBottom: 8, flexWrap: "wrap" }}>
                        <span>None of this Partner&apos;s accounts can be used - only active accounts on the Campaign&apos;s platforms are eligible.</span>
                        <Link href={`/partners/${encodeURIComponent(partnerDetail.partnerRef)}`} className="btn">
                          Open Partner record
                        </Link>
                      </div>
                    )}
                    {partnerDetail.accounts.map((account) => {
                      const inputId = id(`account-${account.partnerAccountRef}`);
                      return (
                        <label key={account.partnerAccountRef} htmlFor={inputId} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontWeight: 450, fontSize: 12, padding: "6px 0", opacity: account.selectable ? 1 : 0.65 }}>
                          <input id={inputId} type="checkbox" disabled={!account.selectable} checked={selectedAccountRefs.includes(account.partnerAccountRef)} onChange={(event) => toggleAccount(account, event.target.checked)} />
                          <span>
                            <b>{account.label}</b> · {account.platformLabel}
                            {account.handle ? ` · @${account.handle.replace(/^@/, "")}` : ""}
                            {account.primary ? " · Primary" : ""}
                            {account.unavailableReason && (
                              <>
                                <br />
                                <small>{account.unavailableReason}</small>
                              </>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>

                  {partnerDetail.accounts.some((account) => account.selectable) && (
                    <div className="fields" style={{ marginTop: 16 }}>
                      <div className="field full">
                        <label htmlFor={id("instructions")}>Partner-specific instructions</label>
                        <textarea id={id("instructions")} maxLength={LIMITS.instructions} value={values.instructions} onChange={(event) => setValue("instructions", event.target.value)} />
                      </div>
                      <div className="field full">
                        <label htmlFor={id("summary")}>Content requirement summary</label>
                        <textarea id={id("summary")} maxLength={LIMITS.contentRequirementSummary} value={values.contentRequirementSummary} onChange={(event) => setValue("contentRequirementSummary", event.target.value)} />
                      </div>
                      <div className="field">
                        <label htmlFor={id("count")}>Required count</label>
                        <input id={id("count")} type="number" inputMode="numeric" min={1} max={LIMITS.requiredCountMax} step={1} value={values.requiredCount} onChange={(event) => setValue("requiredCount", event.target.value)} />
                      </div>
                      <div className="field">
                        <label htmlFor={id("due")}>Due date</label>
                        <input id={id("due")} type="date" value={values.dueAt} onChange={(event) => setValue("dueAt", event.target.value)} />
                      </div>
                      <div className="field">
                        <label htmlFor={id("formats")}>Format(s)</label>
                        <input id={id("formats")} type="text" value={values.formats} onChange={(event) => setValue("formats", event.target.value)} />
                        <small>Comma-separated, e.g. Reel, Story</small>
                      </div>
                      <div className="field">
                        <label htmlFor={id("language")}>Language</label>
                        <input id={id("language")} type="text" maxLength={LIMITS.language} value={values.language} onChange={(event) => setValue("language", event.target.value)} />
                      </div>
                      <div className="field full">
                        <label htmlFor={id("hashtags")}>Hashtags</label>
                        <input id={id("hashtags")} type="text" value={values.hashtags} onChange={(event) => setValue("hashtags", event.target.value)} />
                        <small>Comma-separated; a leading # is removed.</small>
                      </div>

                      <fieldset className="field full" style={{ border: 0, padding: 0, margin: 0 }}>
                        <legend style={{ fontSize: 11, fontWeight: 550, padding: 0, marginBottom: 6 }}>Resource links (optional)</legend>
                        {values.resourceLinks.map((row, index) => (
                          <div key={index} className="fields" style={{ marginBottom: 10 }}>
                            <div className="field">
                              <label htmlFor={id(`link-label-${index}`)}>Link {index + 1} label</label>
                              <input
                                id={id(`link-label-${index}`)}
                                type="text"
                                value={row.label}
                                onChange={(event) => setValue("resourceLinks", values.resourceLinks.map((r, i) => (i === index ? { ...r, label: event.target.value } : r)))}
                              />
                            </div>
                            <div className="field">
                              <label htmlFor={id(`link-url-${index}`)}>Link {index + 1} URL</label>
                              <input
                                id={id(`link-url-${index}`)}
                                type="url"
                                inputMode="url"
                                placeholder="https://"
                                value={row.url}
                                onChange={(event) => setValue("resourceLinks", values.resourceLinks.map((r, i) => (i === index ? { ...r, url: event.target.value } : r)))}
                              />
                            </div>
                            <label htmlFor={id(`link-share-${index}`)} className="field full" style={{ flexDirection: "row", alignItems: "center", gap: 8, fontWeight: 450 }}>
                              <input
                                id={id(`link-share-${index}`)}
                                type="checkbox"
                                checked={row.shareExternally}
                                onChange={(event) => setValue("resourceLinks", values.resourceLinks.map((r, i) => (i === index ? { ...r, shareExternally: event.target.checked } : r)))}
                              />
                              Share this link with the Partner on the public submission page
                            </label>
                            <div className="field full">
                              <button type="button" className="btn" onClick={() => setValue("resourceLinks", values.resourceLinks.filter((_, i) => i !== index))}>
                                Remove link {index + 1}
                              </button>
                            </div>
                          </div>
                        ))}
                        {values.resourceLinks.length < LIMITS.resourceLinksMax && (
                          <div>
                            <button type="button" className="btn" onClick={() => setValue("resourceLinks", [...values.resourceLinks, { label: "", url: "", shareExternally: false }])}>
                              Add resource link
                            </button>
                          </div>
                        )}
                      </fieldset>
                    </div>
                  )}

                  {formErrors.length > 0 && (
                    <div className="banner" role="alert" style={{ marginTop: 14, marginBottom: 0, display: "block" }}>
                      {formErrors.map((message) => (
                        <div key={message}>{message}</div>
                      ))}
                    </div>
                  )}
                  {submitError && (
                    <div className="banner" role="alert" style={{ marginTop: 14, marginBottom: 0 }}>
                      {submitError}
                    </div>
                  )}
                  {submitting && (
                    <p role="status" aria-live="polite" style={{ marginTop: 12 }}>
                      Creating Assignment…
                    </p>
                  )}
                  <p style={{ marginTop: 14, marginBottom: 0 }}>The Assignment is created as a Draft. Issuing it to the Partner is a separate step on the Assignment itself.</p>
                </>
              )}
            </div>
          )}
        </>
      )}
    </DialogShell>
  );
}
