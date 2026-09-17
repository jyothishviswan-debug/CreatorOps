"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { FormLayout, FormSection, Fields, Field, FormFoot, Checklist } from "@/ui/Form";
import { Icon } from "@/ui/icons";
import type { PartnerDto } from "@/server/partners/client-dto";
import type { PartnerOwnerCandidateDto } from "@/server/partners/user-picker";
import { DISCOVERY_PLATFORMS, DISCOVERY_REGIONS, TARGET_AUDIENCES, type TargetAudience } from "@/server/discovery/types";
import { PARTNER_PRIORITIES, PARTNER_TIERS, type PartnerDuplicateCheckResult } from "@/server/partners/types";
import { createPartner, createPartnerAccount, editPartner, precheckPartnerDuplicates } from "./api-client";
import { DuplicateStatusBanner } from "./DuplicateStatus";
import { PartnerOwnerPicker } from "./PartnerOwnerPicker";
import { deriveFromProfileUrl } from "@/features/discovery/profile-url";

function toCsv(values: string[]): string {
  return values.join(", ");
}

function fromCsv(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

type Props = { mode: "create" } | { mode: "edit"; partner: PartnerDto };

export function PartnerForm(props: Props) {
  const router = useRouter();
  const initial = props.mode === "edit" ? props.partner : null;

  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  // Same fixed list Discovery's own Research stage uses - carried over
  // automatically on Discovery conversion (see conversion-service.ts),
  // captured here directly for a Partner created without a Discovery
  // origin. One of the primary classification fields, not an optional
  // afterthought like tier/priority - shown right under the name.
  const [targetAudience, setTargetAudience] = useState<TargetAudience | "">((initial?.targetAudience as TargetAudience | null) ?? "");
  const [legalName, setLegalName] = useState(initial?.legalName ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [regions, setRegions] = useState(toCsv(initial?.regionIds ?? []));
  const [languages, setLanguages] = useState(toCsv(initial?.languageIds ?? []));
  const [categories, setCategories] = useState(toCsv(initial?.categoryIds ?? []));
  const [tier, setTier] = useState(initial?.tier ?? "");
  const [tierOther, setTierOther] = useState(() => {
    const value = initial?.tier ?? "";
    return value !== "" && !(PARTNER_TIERS as readonly string[]).includes(value);
  });
  const [priority, setPriority] = useState(initial?.priority ?? "");
  const [priorityOther, setPriorityOther] = useState(() => {
    const value = initial?.priority ?? "";
    return value !== "" && !(PARTNER_PRIORITIES as readonly string[]).includes(value);
  });

  // Owner assignment is only offered at direct creation, through
  // createPartner's own ownerUserRef field - ordinary edit never touches
  // ownerUid (see setPartnerOwnerTeam, a distinct authorized path with
  // its own action, used from the Partner's own Overview instead).
  const [owner, setOwner] = useState<PartnerOwnerCandidateDto | null>(null);

  // Optional initial Partner Account, create mode only - a real second
  // API call after the Partner itself exists (createPartner has no
  // combined-create shape), using the exact Step 7A.1 identity fields.
  const [addAccount, setAddAccount] = useState(false);
  const [accountPlatform, setAccountPlatform] = useState("");
  const [accountHandle, setAccountHandle] = useState("");
  const [accountProfileUrl, setAccountProfileUrl] = useState("");
  const [accountPlatformId, setAccountPlatformId] = useState("");
  const platformTouched = useRef(false);
  const handleTouched = useRef(false);

  const [duplicateResult, setDuplicateResult] = useState<PartnerDuplicateCheckResult | null>(null);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!addAccount || !accountProfileUrl) return;
    const derived = deriveFromProfileUrl(accountProfileUrl);
    if (derived.platform && !platformTouched.current) setAccountPlatform(derived.platform);
    if (derived.handle && !handleTouched.current) setAccountHandle(derived.handle);
  }, [accountProfileUrl, addAccount]);

  const hasIdentitySignal = Boolean(email.trim() || phone.trim() || (addAccount && (accountProfileUrl.trim() || accountHandle.trim())));
  useEffect(() => {
    if (!hasIdentitySignal) return;
    let cancelled = false;
    const timeout = setTimeout(async () => {
      setCheckingDuplicates(true);
      const result = await precheckPartnerDuplicates({
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        accountIdentity:
          addAccount && accountPlatform.trim()
            ? { platform: accountPlatform.trim(), platformAccountId: accountPlatformId.trim() || undefined, profileUrl: accountProfileUrl.trim() || undefined, handle: accountHandle.trim() || undefined }
            : undefined,
      });
      if (cancelled) return;
      setCheckingDuplicates(false);
      setDuplicateResult(result.ok ? result.data : { status: "unknown", matches: [], checkedAt: new Date().toISOString() });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [email, phone, addAccount, accountPlatform, accountProfileUrl, accountHandle, accountPlatformId, hasIdentitySignal]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setStale(false);

    if (props.mode === "create") {
      const result = await createPartner({
        displayName,
        targetAudience: targetAudience || undefined,
        legalName: legalName.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        regionIds: fromCsv(regions),
        languageIds: fromCsv(languages),
        categoryIds: fromCsv(categories),
        tier: tier.trim() || undefined,
        priority: priority.trim() || undefined,
        ownerUserRef: owner?.userRef,
      });
      setSaving(false);
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      if (addAccount && accountPlatform.trim()) {
        await createPartnerAccount(result.data.partnerRef, {
          platform: accountPlatform.trim(),
          handle: accountHandle.trim() || undefined,
          profileUrl: accountProfileUrl.trim() || undefined,
          platformAccountId: accountPlatformId.trim() || undefined,
          primary: true,
        });
        // The initial account is a convenience, not a precondition for
        // the Partner itself existing - if it fails (e.g. an identity
        // collision), the operator lands on a real Partner and can add
        // the account from its own Accounts panel instead.
      }
      router.push(`/partners/${result.data.partnerRef}`);
      router.refresh();
      return;
    }

    const partner = props.partner;
    const result = await editPartner(partner.partnerRef, {
      displayName,
      targetAudience: targetAudience || null,
      legalName: legalName.trim() || null,
      email: email.trim() || null,
      phone: phone.trim() || null,
      regionIds: fromCsv(regions),
      languageIds: fromCsv(languages),
      categoryIds: fromCsv(categories),
      tier: tier.trim() || null,
      priority: priority.trim() || null,
      expectedVersion: partner.version,
    });
    setSaving(false);
    if (!result.ok) {
      if (result.code === "conflict") {
        setStale(true);
        return;
      }
      setSaveError(result.error);
      return;
    }
    router.push(`/partners/${partner.partnerRef}`);
    router.refresh();
  }

  const cancelHref = initial ? `/partners/${initial.partnerRef}` : "/partners/workspace";

  return (
    <FormLayout>
      <form className="panel" onSubmit={handleSubmit}>
        <FormSection title="Profile essentials" description="Use canonical identifiers to keep the programme free of duplicates.">
          {stale && (
            <div className="banner" role="alert" style={{ marginBottom: 14 }}>
              <b>This Partner was changed elsewhere.</b> Reload before saving again.
              <button className="btn" type="button" onClick={() => window.location.reload()} style={{ marginLeft: 10 }}>
                Reload
              </button>
            </div>
          )}
          <Fields>
            <Field label="Full name">
              <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={200} />
            </Field>
            <Field label="Target Audience">
              <select value={targetAudience} onChange={(e) => setTargetAudience(e.target.value as TargetAudience | "")}>
                <option value="">Not yet tagged</option>
                {TARGET_AUDIENCES.map((ta) => (
                  <option key={ta} value={ta}>
                    {ta}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Legal name">
              <input type="text" value={legalName} onChange={(e) => setLegalName(e.target.value)} maxLength={200} />
            </Field>
            <Field label="Email address">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Mobile number">
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Field label="Regions">
              <input type="text" value={regions} onChange={(e) => setRegions(e.target.value)} placeholder="South, Karnataka" />
            </Field>
            <Field label="Languages">
              <input type="text" value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="English, Malayalam" />
            </Field>
            <Field label="Categories">
              <input type="text" value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="Lifestyle, Comedy" />
            </Field>
            <Field label="Tier">
              <select
                value={tierOther ? "other" : tier}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === "other") {
                    setTierOther(true);
                    setTier("");
                  } else {
                    setTierOther(false);
                    setTier(value);
                  }
                }}
              >
                <option value="">Select tier…</option>
                {PARTNER_TIERS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
                <option value="other">Other</option>
              </select>
              {tierOther && <input type="text" value={tier} placeholder="Tier name" style={{ marginTop: 8 }} onChange={(e) => setTier(e.target.value)} />}
            </Field>
            <Field label="Priority">
              <select
                value={priorityOther ? "other" : priority}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === "other") {
                    setPriorityOther(true);
                    setPriority("");
                  } else {
                    setPriorityOther(false);
                    setPriority(value);
                  }
                }}
              >
                <option value="">Select priority…</option>
                {PARTNER_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
                <option value="other">Other</option>
              </select>
              {priorityOther && <input type="text" value={priority} placeholder="Priority name" style={{ marginTop: 8 }} onChange={(e) => setPriority(e.target.value)} />}
            </Field>
          </Fields>

          {props.mode === "create" && (
            <Field label="Owner" full>
              {owner ? (
                <div className="banner" role="status">
                  <b>{owner.displayName}</b> · {owner.email}
                  <button type="button" className="btn" style={{ marginLeft: 10 }} onClick={() => setOwner(null)}>
                    Clear
                  </button>
                </div>
              ) : (
                <PartnerOwnerPicker onSelect={setOwner} />
              )}
            </Field>
          )}

          <DuplicateStatusBanner result={hasIdentitySignal ? duplicateResult : null} checking={hasIdentitySignal && checkingDuplicates} />
        </FormSection>

        {props.mode === "create" && (
          <FormSection title="Initial Partner Account" description="Optional - add the first platform account now, or create it from the Partner's own Accounts panel afterward.">
            <Field label="">
              <label>
                <input type="checkbox" checked={addAccount} onChange={(e) => setAddAccount(e.target.checked)} style={{ marginRight: 8 }} />
                Add an initial Partner Account
              </label>
            </Field>
            {addAccount && (
              <Fields>
                <Field label="Profile URL">
                  <input type="url" value={accountProfileUrl} onChange={(e) => setAccountProfileUrl(e.target.value)} placeholder="https://instagram.com/handle" />
                </Field>
                <Field label="Platform">
                  <select
                    value={accountPlatform}
                    onChange={(e) => {
                      platformTouched.current = true;
                      setAccountPlatform(e.target.value);
                    }}
                  >
                    <option value="">Select platform…</option>
                    {DISCOVERY_PLATFORMS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Handle">
                  <input
                    type="text"
                    value={accountHandle}
                    onChange={(e) => {
                      handleTouched.current = true;
                      setAccountHandle(e.target.value);
                    }}
                  />
                </Field>
                <Field label="Stable platform account id">
                  <input type="text" value={accountPlatformId} onChange={(e) => setAccountPlatformId(e.target.value)} />
                </Field>
              </Fields>
            )}
          </FormSection>
        )}

        <FormSection title="Regions reference" description="The Region dropdown above shows this starter list.">
          <p className="foundationnote">{DISCOVERY_REGIONS.join(" · ")}</p>
        </FormSection>

        {saveError && (
          <div className="banner" role="alert" style={{ margin: "0 22px 18px" }}>
            <b>Couldn&rsquo;t save.</b> {saveError}
          </div>
        )}

        <FormFoot>
          <small>{props.mode === "create" ? "Creates a real Partner" : `v${initial?.version} · saved changes are immediate`}</small>
          <div className="actions">
            <Link href={cancelHref} className="btn">
              Cancel
            </Link>
            <button type="submit" className="btn primary" disabled={saving || !displayName.trim()}>
              {saving ? "Saving…" : props.mode === "create" ? "Create partner" : "Save changes"}
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
              <Icon name="check" /> Accounts, lifecycle and restricted identity captured from the detail page
            </li>
          </Checklist>
          <div className="scopebox">Owner/team assignment after creation, lifecycle and restricted identity are recorded from the Partner&rsquo;s own detail page.</div>
        </div>
      </aside>
    </FormLayout>
  );
}
