"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import Link from "next/link";

import { DialogShell } from "@/ui/Dialog";
import { SearchInput } from "@/ui/Table";
import type { AssignmentOptionPartner, AssignmentOptionVendor, AssignmentOptionsCampaignContext } from "@/server/campaigns/assignment-options-service";
import { createAssignmentsForPartners } from "@/features/assignments/api-client";
import { getAssignmentCreateOptions } from "./api-client";
import { buildCreateAssignmentsForPartnersInput, EMPTY_CREATE_ASSIGNMENT_FORM, LIMITS, type CreateAssignmentFormValues } from "./create-assignment-form";
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

type BulkResult = { partnerRef: string; outcome: "created" | "existing" | "error"; assignmentRef: string | null; error: string | null };

// One added "Through Vendor" section - a chosen Vendor plus its own independent, searched-and-loaded
// list of ACTIVE mapped Partners and its own selection within that list.
type VendorSection = {
  vendor: AssignmentOptionVendor;
  partners: AssignmentOptionPartner[];
  loading: boolean;
  error: string | null;
  selected: Map<string, AssignmentOptionPartner>;
};

// Finding #40 (user-decided, corrected): Direct and Through-Vendor selection are ADDITIVE, never a
// mutually-exclusive mode choice - the dialog shows a "Direct Partners" panel and any number of "Through
// Vendor" panels (add a Vendor, pick its mapped Partners, repeat) at once, and one submit sends the
// combined selection as ONE bulk request (POST /api/assignments/bulk) - this dialog is a thin client of
// that one endpoint, never its own N-call orchestrator. The server is the authority on merging/rejecting
// overlap (the same Partner picked both directly and through a Vendor is merged, preserving the Vendor
// route; the same Partner picked through two different Vendors is rejected as ambiguous) - this dialog
// does not pre-empt that logic client-side. Every new Assignment created this way starts IN_PROGRESS (not
// Draft) - the old Draft/Issue/Accept steps are not part of this normal flow.
//
// Deliberately absent (same Step 12C.1 boundaries as before): any owner field, review policy, Finance/
// commercial terms, Target Audience, analytics targets, per-Partner Partner Account selection (there is no
// single sensible "the accounts" for a batch of different Partners - see create-assignment-form.ts's own
// comment), and any call that would issue/accept an Assignment, create Content, mint a public token/
// session or open WhatsApp.
export function CreateAssignmentDialog({ campaignRef, onClose }: { campaignRef: string; onClose: (changed: boolean) => void }) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;

  const [context, setContext] = useState<AssignmentOptionsCampaignContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Direct Partners panel: search + multi-select, always visible.
  const [query, setQuery] = useState("");
  const [partners, setPartners] = useState<AssignmentOptionPartner[]>([]);
  const [hasMorePartners, setHasMorePartners] = useState(false);
  const [searching, setSearching] = useState(true);
  const [directSelected, setDirectSelected] = useState<Map<string, AssignmentOptionPartner>>(new Map());

  // Through-Vendor panels: zero or more added Vendor sections, each independent.
  const [vendorSections, setVendorSections] = useState<VendorSection[]>([]);
  const [addingVendor, setAddingVendor] = useState(false);
  const [vendorQuery, setVendorQuery] = useState("");
  const [vendorResults, setVendorResults] = useState<AssignmentOptionVendor[]>([]);
  const [vendorSearching, setVendorSearching] = useState(false);

  const [platforms, setPlatforms] = useState<string[]>([]);
  const [values, setValues] = useState<CreateAssignmentFormValues>(EMPTY_CREATE_ASSIGNMENT_FORM);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<BulkResult[] | null>(null);

  const submittingRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  // Finding #48: due date defaults from the Campaign's own end date (already shown on screen two
  // rows up) instead of a blank retype - but only ONCE, on the first successful context load, and
  // never once the person has deliberately touched the field themselves (same touched-state
  // discipline already established in DiscoveryLeadForm.tsx/PartnerForm.tsx for a not-quite-
  // identical "derive from an already-known value, but never clobber an edit" case - kept as real
  // state, not a ref, because whether the field is still "the default" also drives the hint text
  // below, and reading a ref during render is unsafe/disallowed).
  const [dueAtTouched, setDueAtTouched] = useState(false);
  const [dueAtPrefilled, setDueAtPrefilled] = useState(false);
  // Finding #49: Language is likewise ONE shared value for the whole batch (same "Instructions
  // (shared across every selected Partner)" scope). Its valid choices are the UNION of the
  // currently-selected Partners' own recorded canonical languageIds - never a fixed global list
  // (none exists for this domain) and never inferred from name/region/Campaign text/platform. This
  // union changes as partners are added/removed, so (unlike #48's due-date, which prefills once)
  // this re-derives whenever the union itself actually changes - `lastLanguageUnionKey` (state, not
  // a ref, since it must be compared during render - see the "Adjusting state when a prop changes"
  // pattern at https://react.dev/learn/you-might-not-need-an-effect) tracks the previous key.
  const [languageTouched, setLanguageTouched] = useState(false);
  const [lastLanguageUnionKey, setLastLanguageUnionKey] = useState<string | null>(null);

  // Debounced, abortable Direct Partner search. `q` may be empty - the server then returns its own
  // bounded default page. Always active (Direct is no longer a "mode" that can be switched away from).
  useEffect(() => {
    if (results) return;
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
  }, [query, campaignRef, results]);

  // Debounced, abortable Vendor search, only while the "add a Vendor" picker is open.
  useEffect(() => {
    if (!addingVendor || results) return;
    const controller = new AbortController();
    const timeout = setTimeout(
      async () => {
        setVendorSearching(true);
        const response = await getAssignmentCreateOptions(campaignRef, { vq: vendorQuery.trim() }, controller.signal);
        if (controller.signal.aborted) return;
        setVendorSearching(false);
        if (!response.ok) {
          setLoadError(response.error);
          return;
        }
        setLoadError(null);
        setContext(response.data.campaign);
        setVendorResults(response.data.vendors);
      },
      vendorQuery.length === 0 ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [vendorQuery, addingVendor, campaignRef, results]);

  useEffect(() => {
    if (results) resultRef.current?.focus();
  }, [results]);

  async function addVendorSection(candidate: AssignmentOptionVendor) {
    if (vendorSections.some((section) => section.vendor.vendorRef === candidate.vendorRef)) {
      setAddingVendor(false);
      setVendorQuery("");
      setVendorResults([]);
      return;
    }
    setAddingVendor(false);
    setVendorQuery("");
    setVendorResults([]);
    setVendorSections((current) => [...current, { vendor: candidate, partners: [], loading: true, error: null, selected: new Map() }]);
    const response = await getAssignmentCreateOptions(campaignRef, { vendorRef: candidate.vendorRef });
    setVendorSections((current) =>
      current.map((section) =>
        section.vendor.vendorRef === candidate.vendorRef
          ? response.ok
            ? { ...section, loading: false, partners: response.data.vendorPartners }
            : { ...section, loading: false, error: response.error }
          : section,
      ),
    );
  }

  function removeVendorSection(vendorRef: string) {
    setVendorSections((current) => current.filter((section) => section.vendor.vendorRef !== vendorRef));
  }

  function toggleDirectPartner(partner: AssignmentOptionPartner, checked: boolean) {
    setDirectSelected((current) => {
      const next = new Map(current);
      if (checked) next.set(partner.partnerRef, partner);
      else next.delete(partner.partnerRef);
      return next;
    });
  }

  function toggleVendorPartner(vendorRef: string, partner: AssignmentOptionPartner, checked: boolean) {
    setVendorSections((current) =>
      current.map((section) => {
        if (section.vendor.vendorRef !== vendorRef) return section;
        const next = new Map(section.selected);
        if (checked) next.set(partner.partnerRef, partner);
        else next.delete(partner.partnerRef);
        return { ...section, selected: next };
      }),
    );
  }

  function togglePlatform(platform: string, checked: boolean) {
    setPlatforms((current) => (checked ? [...new Set([...current, platform])] : current.filter((p) => p !== platform)));
  }

  function setValue<K extends keyof CreateAssignmentFormValues>(key: K, value: CreateAssignmentFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  // Finding #48: prefills due date from the Campaign's own endDate, but only ONCE, on the first
  // successful context load, and only when the person hasn't already typed a due date themselves.
  // A Campaign always has a real endDate today (required at creation), but this still never
  // fabricates one if it were ever absent. Adjusted directly during render (React's own documented
  // "Adjusting state when a prop changes" pattern - https://react.dev/learn/you-might-not-need-an-
  // effect - comparing STATE, never a ref, since a ref cannot safely be read during render) rather
  // than inside a useEffect, whose own setState-in-effect would itself cause an extra cascading
  // render for no benefit here.
  if (context && !dueAtPrefilled) {
    setDueAtPrefilled(true);
    if (!dueAtTouched && !values.dueAt && context.endDate) {
      setValues((current) => ({ ...current, dueAt: context.endDate }));
    }
  }

  // Finding #49: the union of every currently-selected Partner's (Direct + every Vendor section's
  // selected Partners) own recorded languageIds - Vendor-routed Partners resolve through the exact
  // same AssignmentOptionPartner shape as Direct ones (assignment-options-service.ts's
  // toSafePartnerOption is the single source for both), so this naturally uses Partner data only,
  // never Vendor data. Filtered to values the stored brief can actually accept (<=60 chars,
  // AssignmentBrief.language's own bound) so a picker option can never itself fail server validation.
  const selectedPartnersForLanguage = [...directSelected.values(), ...vendorSections.flatMap((section) => [...section.selected.values()])];
  const languageUnion = [...new Set(selectedPartnersForLanguage.flatMap((p) => p.languageIds))].filter((l) => l.length <= LIMITS.language).sort();
  const languageUnionKey = languageUnion.join("\u0000");
  const campaignLanguageIds = context?.languageIds ?? [];
  const languageMismatch = campaignLanguageIds.length > 0 && languageUnion.length > 0 && !languageUnion.some((l) => campaignLanguageIds.includes(l));

  // Same render-time "adjust state when a derived value changes" pattern as #48 above, keyed on the
  // union's own identity so it only reacts to an actual Partner-selection change, not every render.
  if (languageUnionKey !== lastLanguageUnionKey) {
    setLastLanguageUnionKey(languageUnionKey);
    if (!languageTouched) {
      // Deterministic preselection only when exactly one distinct known language exists - never
      // guessed/inferred, and cleared back to unset the moment the union stops being singular.
      const next = languageUnion.length === 1 ? languageUnion[0]! : "";
      if (values.language !== next) setValues((current) => ({ ...current, language: next }));
    } else if (values.language && !languageUnion.includes(values.language)) {
      // The person's own explicit choice no longer belongs to the current selection's option set
      // (e.g. the Partner it came from was deselected) - a closed picker cannot keep an orphaned
      // value selected, so it clears and asks for a fresh, explicit choice rather than silently
      // keeping a value that no longer corresponds to any selected Partner.
      setLanguageTouched(false);
      setValues((current) => ({ ...current, language: "" }));
    }
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      listRef.current?.querySelector<HTMLElement>("input,button")?.focus();
    }
  }

  // The distinct Partner count across Direct + every Vendor section, deduped for display - the server is
  // the one that actually resolves/merges a Partner picked in more than one place at submit time, but the
  // button label and brief-field visibility should reflect the real distinct count, not an inflated sum.
  const allSelectedPartnerRefs = new Set<string>([...directSelected.keys(), ...vendorSections.flatMap((section) => [...section.selected.keys()])]);
  const selectedCount = allSelectedPartnerRefs.size;
  const canSubmit = selectedCount > 0 && !submitting && !results;

  // A partner's display info, looked up across every panel that could have surfaced it (available or
  // selected, Direct or any Vendor section) - used for the post-submit results list and the pre-submit
  // combined summary alike.
  function findPartnerDisplay(partnerRef: string): AssignmentOptionPartner | undefined {
    return (
      partners.find((p) => p.partnerRef === partnerRef) ??
      directSelected.get(partnerRef) ??
      vendorSections.flatMap((section) => section.partners).find((p) => p.partnerRef === partnerRef) ??
      vendorSections.flatMap((section) => [...section.selected.values()]).find((p) => p.partnerRef === partnerRef)
    );
  }

  async function submit() {
    if (submittingRef.current) return;
    const built = buildCreateAssignmentsForPartnersInput({
      campaignRef,
      directPartnerRefs: [...directSelected.keys()],
      vendorSelections: vendorSections.filter((section) => section.selected.size > 0).map((section) => ({ vendorRef: section.vendor.vendorRef, partnerRefs: [...section.selected.keys()] })),
      platforms,
      values,
    });
    if (!built.ok) {
      setFormErrors(built.errors);
      return;
    }
    setFormErrors([]);
    setSubmitError(null);
    submittingRef.current = true;
    setSubmitting(true);
    const response = await createAssignmentsForPartners(built.input);
    submittingRef.current = false;
    setSubmitting(false);
    if (!response.ok) {
      setSubmitError(response.error);
      return;
    }
    setResults(response.data.results);
  }

  const handleClose = () => onClose(Boolean(results?.some((r) => r.outcome === "created")));

  const footer = results ? (
    <button type="button" className="btn primary" onClick={handleClose}>
      Done
    </button>
  ) : (
    <>
      <button type="button" className="btn" onClick={handleClose} disabled={submitting} style={submitting ? DISABLED_FOOTER_BUTTON_STYLE : undefined}>
        Cancel
      </button>
      <button type="button" className="btn primary" onClick={() => void submit()} disabled={!canSubmit} style={canSubmit ? undefined : DISABLED_FOOTER_BUTTON_STYLE}>
        {submitting ? "Creating…" : selectedCount > 1 ? `Create ${selectedCount} Assignments` : "Create Assignment"}
      </button>
    </>
  );

  return (
    <DialogShell open title="Create Assignment(s)" onClose={handleClose} footer={footer}>
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
              <span>Dates</span>
              <span>
                {dateLabel(context.startDate)} – {dateLabel(context.endDate)}
              </span>
            </div>
          </div>

          {results && (
            <div ref={resultRef} tabIndex={-1} role="status" className="banner" style={{ marginTop: 16, marginBottom: 0, flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
              <b>
                {results.filter((r) => r.outcome === "created").length} created, {results.filter((r) => r.outcome === "existing").length} already existed,{" "}
                {results.filter((r) => r.outcome === "error").length} failed.
              </b>
              {results.map((r) => {
                const partner = findPartnerDisplay(r.partnerRef);
                return (
                  <div key={r.partnerRef} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span>{partner?.displayName ?? r.partnerRef}</span>
                    {r.outcome === "created" && r.assignmentRef && (
                      <Link href={`/assignments/${encodeURIComponent(r.assignmentRef)}`} className="btn">
                        Created — open
                      </Link>
                    )}
                    {r.outcome === "existing" && <small>{r.assignmentRef ? "Already has an Assignment" : "Already has an Assignment (not visible to you)"}</small>}
                    {r.outcome === "error" && <small style={{ color: "var(--red)" }}>{r.error}</small>}
                  </div>
                );
              })}
            </div>
          )}

          {!results && (
            <div style={{ marginTop: 16 }}>
              <div className="field full">
                <label htmlFor={id("partner-search")}>Direct Partners</label>
                <SearchInput id={id("partner-search")} placeholder="Search Partners by name…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onSearchKeyDown} autoComplete="off" />
                {searching && (
                  <small role="status" aria-live="polite">
                    Searching Partners…
                  </small>
                )}
                {!searching && partners.length === 0 && <small role="status">{query.trim() ? `No active Partners match “${query.trim()}”.` : "No active Partners are available to you."}</small>}
                {partners.length > 0 && (
                  <div className="searchresults" style={{ marginTop: 6 }} ref={listRef} role="group" aria-label="Partner results">
                    {partners.map((candidate) => {
                      const inputId = id(`partner-${candidate.partnerRef}`);
                      return (
                        <label key={candidate.partnerRef} htmlFor={inputId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
                          <input id={inputId} type="checkbox" checked={directSelected.has(candidate.partnerRef)} onChange={(event) => toggleDirectPartner(candidate, event.target.checked)} />
                          <span>
                            <b>{candidate.displayName}</b>
                            {candidate.regionLabels.length > 0 && <small> · {candidate.regionLabels.join(", ")}</small>}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                {hasMorePartners && !searching && <small>Showing the first {partners.length} Partners — type to narrow the search.</small>}
              </div>

              <div className="field full" style={{ marginTop: 16 }}>
                <label>Through Vendor</label>

                {vendorSections.map((section) => (
                  <div key={section.vendor.vendorRef} className="banner" style={{ flexDirection: "column", alignItems: "flex-start", gap: 8, marginTop: 8, marginBottom: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", width: "100%", alignItems: "center" }}>
                      <b>{section.vendor.displayName}</b>
                      <button type="button" className="btn" onClick={() => removeVendorSection(section.vendor.vendorRef)} aria-label={`Remove Vendor ${section.vendor.displayName}`}>
                        Remove
                      </button>
                    </div>
                    {section.loading && (
                      <p role="status" aria-live="polite" style={{ margin: 0 }}>
                        Loading this Vendor&apos;s Partners…
                      </p>
                    )}
                    {section.error && (
                      <div className="banner" role="alert" style={{ margin: 0 }}>
                        {section.error}
                      </div>
                    )}
                    {!section.loading && !section.error && section.partners.length === 0 && (
                      <div className="banner" role="status" style={{ margin: 0 }}>
                        This Vendor has no active linked Partners.
                      </div>
                    )}
                    {section.partners.length > 0 && (
                      <div className="searchresults" style={{ width: "100%" }} role="group" aria-label={`${section.vendor.displayName} Partner results`}>
                        {section.partners.map((candidate) => {
                          const inputId = id(`vendor-${section.vendor.vendorRef}-partner-${candidate.partnerRef}`);
                          return (
                            <label key={candidate.partnerRef} htmlFor={inputId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
                              <input
                                id={inputId}
                                type="checkbox"
                                checked={section.selected.has(candidate.partnerRef)}
                                onChange={(event) => toggleVendorPartner(section.vendor.vendorRef, candidate, event.target.checked)}
                              />
                              <span>
                                <b>{candidate.displayName}</b>
                                {candidate.regionLabels.length > 0 && <small> · {candidate.regionLabels.join(", ")}</small>}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}

                {addingVendor ? (
                  <div style={{ marginTop: 8 }}>
                    <SearchInput id={id("vendor-search")} placeholder="Search Vendors by name…" value={vendorQuery} onChange={(event) => setVendorQuery(event.target.value)} autoComplete="off" />
                    {vendorSearching && (
                      <small role="status" aria-live="polite">
                        Searching Vendors…
                      </small>
                    )}
                    {!vendorSearching && vendorResults.length === 0 && <small role="status">{vendorQuery.trim() ? `No active Vendors match “${vendorQuery.trim()}”.` : "No active Vendors are available to you."}</small>}
                    {vendorResults.length > 0 && (
                      <div className="searchresults" style={{ marginTop: 6 }} role="group" aria-label="Vendor results">
                        {vendorResults.map((candidate) => (
                          <button key={candidate.vendorRef} type="button" disabled={vendorSections.some((s) => s.vendor.vendorRef === candidate.vendorRef)} onClick={() => void addVendorSection(candidate)}>
                            <b>{candidate.displayName}</b>
                            {vendorSections.some((s) => s.vendor.vendorRef === candidate.vendorRef) && <small> · already added</small>}
                          </button>
                        ))}
                      </div>
                    )}
                    <div style={{ marginTop: 6 }}>
                      <button type="button" className="btn" onClick={() => { setAddingVendor(false); setVendorQuery(""); setVendorResults([]); }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ marginTop: 8 }}>
                    <button type="button" className="btn" onClick={() => setAddingVendor(true)}>
                      + Add Vendor
                    </button>
                  </div>
                )}
              </div>

              {selectedCount > 0 && (
                <>
                  <div className="field full" style={{ marginTop: 16 }}>
                    <label>Selection summary</label>
                    <div className="banner" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4, marginBottom: 0 }}>
                      {directSelected.size > 0 && (
                        <span>
                          <b>Direct:</b> {[...directSelected.values()].map((p) => p.displayName).join(", ")}
                        </span>
                      )}
                      {vendorSections
                        .filter((section) => section.selected.size > 0)
                        .map((section) => (
                          <span key={section.vendor.vendorRef}>
                            <b>{section.vendor.displayName}:</b> {[...section.selected.values()].map((p) => p.displayName).join(", ")}
                          </span>
                        ))}
                    </div>
                  </div>

                  <fieldset className="field full" style={{ border: 0, padding: 0, margin: "16px 0 0" }}>
                    <legend style={{ fontSize: 11, fontWeight: 550, padding: 0, marginBottom: 6 }}>Platform(s)</legend>
                    {context.platforms.map((p) => {
                      const inputId = id(`platform-${p.platform}`);
                      return (
                        <label key={p.platform} htmlFor={inputId} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 14, fontWeight: 450, fontSize: 12 }}>
                          <input id={inputId} type="checkbox" checked={platforms.includes(p.platform)} onChange={(event) => togglePlatform(p.platform, event.target.checked)} />
                          {p.platformLabel}
                        </label>
                      );
                    })}
                  </fieldset>

                  <div className="fields" style={{ marginTop: 16 }}>
                    <div className="field full">
                      <label htmlFor={id("instructions")}>Instructions (shared across every selected Partner)</label>
                      <textarea id={id("instructions")} maxLength={LIMITS.instructions} value={values.instructions} onChange={(event) => setValue("instructions", event.target.value)} />
                      {/* Finding #52: distinguishes this field from Content requirement summary below - recipient-facing guidance for THIS Assignment, not a place to repeat the Campaign's own Objective/Resources. */}
                      <small>What the recipient(s) should actually do. Don&rsquo;t repeat the Campaign&rsquo;s own Objective or Resources - those already reach the submission page automatically.</small>
                    </div>
                    <div className="field full">
                      <label htmlFor={id("summary")}>Content requirement summary (optional override)</label>
                      <textarea id={id("summary")} maxLength={LIMITS.contentRequirementSummary} value={values.contentRequirementSummary} onChange={(event) => setValue("contentRequirementSummary", event.target.value)} />
                      <small>Only fill this in if the Campaign&rsquo;s Objective, Resources and the structured fields here (platform, due date, required count) genuinely aren&rsquo;t enough on their own. Leave blank otherwise.</small>
                    </div>
                    <div className="field">
                      <label htmlFor={id("count")}>Required count</label>
                      <input id={id("count")} type="number" inputMode="numeric" min={1} max={LIMITS.requiredCountMax} step={1} value={values.requiredCount} onChange={(event) => setValue("requiredCount", event.target.value)} />
                    </div>
                    <div className="field">
                      <label htmlFor={id("due")}>Due date</label>
                      <input
                        id={id("due")}
                        type="date"
                        value={values.dueAt}
                        onChange={(event) => {
                          setDueAtTouched(true);
                          setValue("dueAt", event.target.value);
                        }}
                      />
                      {values.dueAt && !dueAtTouched && <small>Defaulted from the Campaign&rsquo;s own end date - editable here.</small>}
                    </div>
                    <div className="field">
                      <label htmlFor={id("formats")}>Format(s)</label>
                      <input id={id("formats")} type="text" value={values.formats} onChange={(event) => setValue("formats", event.target.value)} />
                      <small>Comma-separated, e.g. Reel, Story</small>
                    </div>
                    <div className="field">
                      <label htmlFor={id("language")}>Language</label>
                      <select
                        id={id("language")}
                        value={values.language}
                        disabled={languageUnion.length === 0}
                        onChange={(event) => {
                          setLanguageTouched(true);
                          setValue("language", event.target.value);
                        }}
                      >
                        <option value="">{languageUnion.length === 0 ? "No known language for the selected Partner(s)" : "No language specified"}</option>
                        {languageUnion.map((lang) => (
                          <option key={lang} value={lang}>
                            {lang}
                          </option>
                        ))}
                      </select>
                      {languageUnion.length === 1 && values.language === languageUnion[0] && !languageTouched && (
                        <small>Defaulted from the selected Partner&rsquo;s own recorded language - editable here.</small>
                      )}
                      {languageMismatch && (
                        <small className="fielderror" role="alert">
                          The Campaign&rsquo;s own language requirement ({campaignLanguageIds.join(", ")}) has no overlap with the selected Partner(s)&rsquo; recorded language(s) ({languageUnion.join(", ")}
                          ).
                        </small>
                      )}
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
                </>
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
                  Creating Assignment(s)…
                </p>
              )}
              <p style={{ marginTop: 14, marginBottom: 0 }}>Each new Assignment is created In Progress — Partner Accounts and further edits are managed on the Assignment itself.</p>
            </div>
          )}
        </>
      )}
    </DialogShell>
  );
}
