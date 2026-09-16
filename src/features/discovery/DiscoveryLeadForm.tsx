"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { FormLayout, FormSection, Fields, Field, FormFoot, Checklist } from "@/ui/Form";
import { Icon } from "@/ui/icons";
import type { LeadDto } from "@/server/discovery/client-dto";
import { LEAD_SOURCE_TYPES, type DuplicateCheckResult, type LeadSourceType } from "@/server/discovery/types";
import { createLead, precheckDuplicates, updateLead } from "./api-client";
import { DuplicateStatusBanner } from "./DuplicateStatus";
import { deriveFromProfileUrl } from "./profile-url";

const SOURCE_LABELS: Record<LeadSourceType, string> = {
  research: "Research",
  referral: "Referral",
  inbound: "Inbound",
  other: "Other",
};

type Props = { mode: "create" } | { mode: "edit"; lead: LeadDto };

export function DiscoveryLeadForm(props: Props) {
  const router = useRouter();
  const initial = props.mode === "edit" ? props.lead : null;

  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [profileUrl, setProfileUrl] = useState(initial?.profileUrl ?? "");
  const [platform, setPlatform] = useState(initial?.platform ?? "");
  const [handle, setHandle] = useState(initial?.handle ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [region, setRegion] = useState(initial?.region ?? "");
  const [teamId, setTeamId] = useState(initial?.teamId ?? "");
  const [sourceType, setSourceType] = useState<LeadSourceType>(initial?.source.type ?? "research");
  const [sourceNote, setSourceNote] = useState(initial?.source.note ?? "");
  const platformTouched = useRef(props.mode === "edit");
  const handleTouched = useRef(props.mode === "edit");

  const [duplicateResult, setDuplicateResult] = useState<DuplicateCheckResult | null>(null);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  // Platform/handle may be derived from the profile URL when safe, but
  // must remain correctable - only auto-fill fields the operator hasn't
  // already touched themselves.
  useEffect(() => {
    if (!profileUrl) return;
    const derived = deriveFromProfileUrl(profileUrl);
    if (derived.platform && !platformTouched.current) setPlatform(derived.platform);
    if (derived.handle && !handleTouched.current) setHandle(derived.handle);
  }, [profileUrl]);

  // Bounded, datastore-backed duplicate pre-check, debounced - never a
  // client-side "look for duplicates in a preloaded list". Nothing is
  // set synchronously when there's no signal to check yet - the empty
  // case is derived at render time instead (see hasIdentitySignal below).
  const hasIdentitySignal = Boolean(email.trim() || phone.trim() || profileUrl.trim() || handle.trim());
  useEffect(() => {
    if (!hasIdentitySignal) return;
    let cancelled = false;
    const timeout = setTimeout(async () => {
      setCheckingDuplicates(true);
      const result = await precheckDuplicates({
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        profileUrl: profileUrl.trim() || undefined,
        handle: handle.trim() || undefined,
      });
      if (cancelled) return;
      setCheckingDuplicates(false);
      // A failed lookup must show Unknown/Error, never silently "no
      // duplicate" - a network/API failure here is exactly that failure.
      setDuplicateResult(result.ok ? result.data : { status: "unknown", matches: [], checkedAt: new Date().toISOString() });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [email, phone, profileUrl, handle, hasIdentitySignal]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setStale(false);

    if (props.mode === "create") {
      const result = await createLead({
        displayName,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        profileUrl: profileUrl.trim() || undefined,
        platform: platform.trim() || undefined,
        handle: handle.trim() || undefined,
        source: { type: sourceType, note: sourceNote.trim() || undefined },
        region: region.trim() || undefined,
        teamId: teamId.trim() || undefined,
      });
      setSaving(false);
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      router.push(`/discovery/${result.data.leadRef}`);
      return;
    }

    const lead = props.lead;
    const result = await updateLead(lead.leadRef, {
      displayName,
      email: email.trim() || null,
      phone: phone.trim() || null,
      profileUrl: profileUrl.trim() || null,
      platform: platform.trim() || null,
      handle: handle.trim() || null,
      source: { type: sourceType, note: sourceNote.trim() || undefined },
      region: region.trim() || null,
      teamId: teamId.trim() || null,
      expectedVersion: lead.version,
    });
    setSaving(false);
    if (!result.ok) {
      if (result.code === "stale_write") {
        setStale(true);
        return;
      }
      setSaveError(result.error);
      return;
    }
    router.push(`/discovery/${lead.leadRef}`);
  }

  const cancelHref = initial ? `/discovery/${initial.leadRef}` : "/discovery/leads";

  return (
    <FormLayout>
      <form className="panel" onSubmit={handleSubmit}>
        <FormSection title="Profile essentials" description="Use canonical identifiers to keep the programme free of duplicates.">
          {stale && (
            <div className="banner" role="alert" style={{ marginBottom: 14 }}>
              <b>This Lead was changed elsewhere.</b> Reload before saving again.
              <button className="btn" type="button" onClick={() => window.location.reload()} style={{ marginLeft: 10 }}>
                Reload
              </button>
            </div>
          )}
          <Fields>
            <Field label="Full name">
              <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={200} />
            </Field>
            <Field label="Profile URL" hint="The primary platform profile - prominent because it drives duplicate checking and platform/handle detection.">
              <input type="url" value={profileUrl} onChange={(e) => setProfileUrl(e.target.value)} placeholder="https://instagram.com/handle" />
            </Field>
            <Field label="Platform" hint="Derived from the profile URL when recognized - always correctable.">
              <input
                type="text"
                value={platform}
                onChange={(e) => {
                  platformTouched.current = true;
                  setPlatform(e.target.value);
                }}
              />
            </Field>
            <Field label="Handle" hint="Derived from the profile URL when safe - always correctable.">
              <input
                type="text"
                value={handle}
                onChange={(e) => {
                  handleTouched.current = true;
                  setHandle(e.target.value);
                }}
                placeholder="handle"
              />
            </Field>
            <Field label="Email address">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Mobile number" hint="Include the country code.">
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Field label="Region">
              <input type="text" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="e.g. Kerala" />
            </Field>
            <Field label="Team / portfolio" hint="Scope context - used for record-scope authorization.">
              <input type="text" value={teamId} onChange={(e) => setTeamId(e.target.value)} placeholder="e.g. kerala-programmes" />
            </Field>
          </Fields>

          <DuplicateStatusBanner result={hasIdentitySignal ? duplicateResult : null} checking={hasIdentitySignal && checkingDuplicates} />
        </FormSection>

        <FormSection title="Source & context" description="Capture useful details without making the simple path complicated.">
          <Fields>
            <Field label="Source">
              <select value={sourceType} onChange={(e) => setSourceType(e.target.value as LeadSourceType)}>
                {LEAD_SOURCE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {SOURCE_LABELS[type]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Source note" full hint="Optional context - never a required blocker.">
              <input type="text" value={sourceNote} onChange={(e) => setSourceNote(e.target.value)} maxLength={300} />
            </Field>
          </Fields>
          <p className="foundationnote" style={{ marginTop: 12 }}>
            No postal address or address proof is collected anywhere in Discovery. Research, review, outreach, commercial, agreement, asset and KYC evidence are captured from the Lead&rsquo;s own detail page once created.
          </p>
        </FormSection>

        {saveError && (
          <div className="banner" role="alert" style={{ margin: "0 22px 18px" }}>
            <b>Couldn&rsquo;t save.</b> {saveError}
          </div>
        )}

        <FormFoot>
          <small>{props.mode === "create" ? "Creates a real Discovery Lead" : `v${initial?.version} · saved changes are immediate`}</small>
          <div className="actions">
            <Link href={cancelHref} className="btn">
              Cancel
            </Link>
            <button type="submit" className="btn primary" disabled={saving || !displayName.trim()}>
              {saving ? "Saving…" : props.mode === "create" ? "Create lead" : "Save changes"}
            </button>
          </div>
        </FormFoot>
      </form>

      <aside className="panel">
        <div className="panelhead">
          <h2>A cleaner first step</h2>
        </div>
        <div className="panelbody">
          <Checklist>
            <li>
              <Icon name="check" /> Capture essential identity
            </li>
            <li>
              <Icon name="check" /> Real bounded duplicate checks
            </li>
            <li>
              <Icon name="check" /> No postal address collected
            </li>
            <li>
              <Icon name="check" /> Owner/manager/KYC captured from the detail page
            </li>
          </Checklist>
          <div className="scopebox">Research, review, outreach, agreement, asset setup, manager and KYC evidence are recorded from the Lead&rsquo;s own workflow rail after creation.</div>
        </div>
      </aside>
    </FormLayout>
  );
}
