"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import { Icon } from "@/ui/icons";
import type { PartnerAccountDto } from "@/server/partners/client-dto";
import { DISCOVERY_PLATFORMS } from "@/server/discovery/types";
import { deriveFromProfileUrl, profileUrlHandleConflict } from "@/server/shared/account-identity";
import { createPartnerAccount, editPartnerAccount, listPartnerAccounts, setPartnerAccountStatus, setPrimaryPartnerAccount } from "./api-client";
import { relativeTime } from "./format";

// Finding #18: prefilled from the owning Partner's own confirmed
// Discovery Platform (partner.sourceDiscovery.snapshot.platform), passed
// down from PartnerDetail.tsx - null for a Partner with no Discovery
// origin, in which case Platform is left blank and must be explicitly
// selected, exactly as before.
export function PartnerAccountsPanel({
  partnerRef,
  pendingSetup,
  sourceDiscoveryPlatform,
  onChanged,
}: {
  partnerRef: string;
  pendingSetup: boolean;
  sourceDiscoveryPlatform?: string | null;
  onChanged?: () => void;
}) {
  const [accounts, setAccounts] = useState<PartnerAccountDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editingRef, setEditingRef] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listPartnerAccounts(partnerRef).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setAccounts(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [partnerRef, refreshKey]);

  function handleChanged() {
    setRefreshKey((k) => k + 1);
    setCreating(false);
    setEditingRef(null);
    onChanged?.();
  }

  const noActivePrimary = accounts.length > 0 && !accounts.some((a) => a.primary && a.status === "ACTIVE");

  return (
    <Panel span={12}>
      <PanelHead
        title="Partner Accounts"
        description="Platform/channel accounts belonging to this Partner - identity evolves per Step 7A.1, a stable platform id can never be casually replaced."
        link={
          !creating && (
            <button type="button" className="btn" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Add account
            </button>
          )
        }
      />
      <PanelBody>
        {pendingSetup && (
          <div className="banner" role="status" style={{ marginBottom: 14 }}>
            <b>Account setup pending.</b> This Partner was created by Discovery conversion with no account yet. Create a real Partner Account below to resolve it - nothing is fabricated.
          </div>
        )}
        {noActivePrimary && accounts.length > 0 && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }}>
            <b>No primary account.</b> This Partner has no active primary Partner Account. Set one below.
          </div>
        )}

        {creating && (
          <AccountForm
            mode="create"
            partnerRef={partnerRef}
            sourceDiscoveryPlatform={sourceDiscoveryPlatform ?? null}
            onSaved={handleChanged}
            onCancel={() => setCreating(false)}
          />
        )}

        {loading ? (
          <Skeleton lines={3} />
        ) : error ? (
          <div className="banner" role="alert">
            {error}
          </div>
        ) : accounts.length === 0 && !creating ? (
          <EmptyState title="No Partner Accounts yet" description="Add a real platform account to establish this Partner's identity." icon="link" />
        ) : (
          accounts.map((account) =>
            editingRef === account.partnerAccountRef ? (
              <AccountForm key={account.partnerAccountRef} mode="edit" account={account} onSaved={handleChanged} onCancel={() => setEditingRef(null)} />
            ) : (
              <AccountRow key={account.partnerAccountRef} account={account} onEdit={() => setEditingRef(account.partnerAccountRef)} onChanged={handleChanged} />
            ),
          )
        )}
      </PanelBody>
    </Panel>
  );
}

function AccountRow({ account, onEdit, onChanged }: { account: PartnerAccountDto; onEdit: () => void; onChanged: () => void }) {
  const [confirmingInactivate, setConfirmingInactivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggleStatus() {
    if (account.primary && account.status === "ACTIVE" && !confirmingInactivate) {
      setConfirmingInactivate(true);
      return;
    }
    setBusy(true);
    setError(null);
    const nextStatus = account.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    const result = await setPartnerAccountStatus(account.partnerAccountRef, { status: nextStatus, expectedVersion: account.version });
    setBusy(false);
    setConfirmingInactivate(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onChanged();
  }

  async function makePrimary() {
    setBusy(true);
    setError(null);
    const result = await setPrimaryPartnerAccount(account.partnerAccountRef, { expectedVersion: account.version });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onChanged();
  }

  return (
    <div className="record" style={{ marginBottom: 10 }}>
      <div className="recordmeta" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <b>{account.platform}</b>
          {account.primary && <Pill tone="default"> Primary</Pill>}
          <Pill tone={account.status === "ACTIVE" ? "default" : "gray"}> {account.status === "ACTIVE" ? "Active" : "Inactive"}</Pill>
          <div>
            <small>
              {account.displayName ?? account.handle ?? "No display name"} {account.handle ? `· @${account.handle}` : ""} {account.platformAccountId ? "· stable id on file" : ""}
            </small>
          </div>
          {account.profileUrl && (
            <div>
              <small>
                <a href={account.profileUrl} target="_blank" rel="noreferrer">
                  {account.profileUrl}
                </a>
              </small>
            </div>
          )}
          {account.followerSnapshot && (
            <div>
              <small>
                {account.followerSnapshot.count.toLocaleString()} followers · as of {relativeTime(account.followerSnapshot.asOf)}
              </small>
            </div>
          )}
          {account.originAssetDecision && (
            <div>
              <small>Origin: Discovery ({account.originAssetDecision.replace(/_/g, " ").toLowerCase()})</small>
            </div>
          )}
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={onEdit}>
            Edit
          </button>
          {!account.primary && account.status === "ACTIVE" && (
            <button type="button" className="btn" disabled={busy} onClick={makePrimary}>
              Set primary
            </button>
          )}
          <button type="button" className="btn" disabled={busy} onClick={toggleStatus}>
            {busy ? "Saving…" : account.status === "ACTIVE" ? "Inactivate" : "Activate"}
          </button>
        </div>
      </div>
      {confirmingInactivate && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          <b>This is the primary account.</b> Inactivating it will leave this Partner with no primary account - nothing is auto-promoted.
          <div className="actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn" onClick={() => setConfirmingInactivate(false)}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={toggleStatus}>
              Inactivate anyway
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </div>
  );
}

type AccountFormProps =
  | { mode: "create"; partnerRef: string; sourceDiscoveryPlatform: string | null; onSaved: () => void; onCancel: () => void }
  | { mode: "edit"; account: PartnerAccountDto; onSaved: () => void; onCancel: () => void };

function AccountForm(props: AccountFormProps) {
  const initial = props.mode === "edit" ? props.account : null;
  // Finding #18: create mode prefills from the Partner's own confirmed
  // Discovery Platform when present - still just the field's initial
  // value, never force-selected, so "require explicit selection when
  // absent" and "never silently overwrite" both fall out naturally (a
  // blank prop leaves the field blank; the value stays freely editable).
  const [platform, setPlatform] = useState(() => (props.mode === "create" ? (props.sourceDiscoveryPlatform ?? "") : (initial?.platform ?? "")));
  // Finding #19: the dropdown covers the canonical Discovery platform
  // list; "Other" reveals a free-text fallback - platform stays free
  // text server-side (same discipline as Discovery's own Lead.platform),
  // so a prefilled or existing value outside the list still shows (and
  // stays editable) via that fallback rather than being blanked.
  const [platformOther, setPlatformOther] = useState(() => {
    const value = props.mode === "create" ? (props.sourceDiscoveryPlatform ?? "") : (initial?.platform ?? "");
    return value !== "" && !(DISCOVERY_PLATFORMS as readonly string[]).includes(value);
  });
  const [handle, setHandle] = useState(initial?.handle ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [profileUrl, setProfileUrl] = useState(initial?.profileUrl ?? "");
  const [platformAccountId, setPlatformAccountId] = useState(initial?.platformAccountId ?? "");
  const [followerCount, setFollowerCount] = useState(initial?.followerSnapshot ? String(initial.followerSnapshot.count) : "");
  const [primary, setPrimary] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const platformTouched = useRef(props.mode === "edit");
  const handleTouched = useRef(props.mode === "edit");

  // Finding #20: Profile URL -> Handle (and, in create mode, Platform)
  // derivation - deterministic only, never fuzzy, and never overwrites a
  // field the operator (or the Discovery prefill above) already touched.
  // Mirrors DiscoveryLeadForm.tsx's own identical effect exactly.
  useEffect(() => {
    if (props.mode !== "create" || !profileUrl) return;
    const derived = deriveFromProfileUrl(profileUrl);
    if (derived.platform && !platformTouched.current) {
      setPlatform(derived.platform);
      setPlatformOther(!(DISCOVERY_PLATFORMS as readonly string[]).includes(derived.platform));
    }
    if (derived.handle && !handleTouched.current) setHandle(derived.handle);
  }, [profileUrl, props.mode]);

  const stableIdLocked = props.mode === "edit" && Boolean(initial?.platformAccountId);
  // Finding #20: a real disagreement between Profile URL and Handle must
  // be shown clearly, never silently resolved - a render-time check
  // (not stored state), using the same shared deterministic-derivation
  // helper the server itself validates with.
  const identityConflict = Boolean(profileUrl.trim() && handle.trim() && profileUrlHandleConflict(profileUrl.trim(), handle.trim()));

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    if (props.mode === "create") {
      const result = await createPartnerAccount(props.partnerRef, {
        platform: platform.trim(),
        handle: handle.trim() || undefined,
        displayName: displayName.trim() || undefined,
        profileUrl: profileUrl.trim() || undefined,
        platformAccountId: platformAccountId.trim() || undefined,
        followerCount: followerCount.trim() ? Number(followerCount) : undefined,
        primary,
      });
      setSaving(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      props.onSaved();
      return;
    }

    const result = await editPartnerAccount(props.account.partnerAccountRef, {
      handle: handle.trim() || null,
      displayName: displayName.trim() || null,
      profileUrl: profileUrl.trim() || null,
      platformAccountId: platformAccountId.trim() || null,
      followerCount: followerCount.trim() ? Number(followerCount) : null,
      expectedVersion: props.account.version,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    props.onSaved();
  }

  return (
    <form onSubmit={handleSubmit} className="record" style={{ marginBottom: 14 }}>
      {/* Finding #20: field order is Platform -> Profile URL -> Handle ->
          remaining account fields. */}
      <div className="fields">
        <div className="field">
          <label>Platform (required)</label>
          {props.mode === "create" ? (
            <>
              <select
                value={platformOther ? "other" : platform}
                onChange={(e) => {
                  platformTouched.current = true;
                  const value = e.target.value;
                  if (value === "other") {
                    setPlatformOther(true);
                    setPlatform("");
                  } else {
                    setPlatformOther(false);
                    setPlatform(value);
                  }
                }}
                required
              >
                <option value="">Select platform…</option>
                {DISCOVERY_PLATFORMS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
                <option value="other">Other</option>
              </select>
              {platformOther && (
                <input
                  type="text"
                  value={platform}
                  placeholder="Platform name"
                  style={{ marginTop: 8 }}
                  onChange={(e) => {
                    platformTouched.current = true;
                    setPlatform(e.target.value);
                  }}
                  required
                />
              )}
            </>
          ) : (
            <input type="text" value={platform} disabled />
          )}
        </div>
        <div className="field">
          <label>Profile URL (optional)</label>
          <input type="url" value={profileUrl} onChange={(e) => setProfileUrl(e.target.value)} placeholder="https://instagram.com/handle" />
        </div>
        <div className="field">
          <label>Handle (optional)</label>
          <input
            type="text"
            value={handle}
            onChange={(e) => {
              handleTouched.current = true;
              setHandle(e.target.value);
            }}
            placeholder="handle"
          />
          {identityConflict && (
            <small role="alert" style={{ color: "var(--danger, #b91c1c)" }}>
              Profile URL and Handle appear to identify different accounts. Correct one of them, or clear Handle to derive it from the Profile URL.
            </small>
          )}
        </div>
        <div className="field">
          <label>Display name (optional)</label>
          <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="field">
          <label>Stable platform account id (optional) {stableIdLocked && "(locked once set)"}</label>
          <input type="text" value={platformAccountId} onChange={(e) => setPlatformAccountId(e.target.value)} disabled={stableIdLocked} />
          {/* Reserved (not conditionally rendered) so this row's height
              never depends on stableIdLocked - `visibility: hidden` keeps
              the layout space without showing or announcing it when the
              id isn't locked, so its "Follower count" sibling never
              shifts. */}
          <small style={{ visibility: stableIdLocked ? "visible" : "hidden" }}>A stable id already on file cannot be replaced or cleared through an ordinary edit.</small>
        </div>
        <div className="field">
          <label>Follower count (optional)</label>
          <input type="number" min={0} value={followerCount} onChange={(e) => setFollowerCount(e.target.value)} />
          {/* Matches its row sibling's reserved hint line so both cells
              in this row are always the same height. */}
          <small style={{ visibility: "hidden" }} aria-hidden="true">
            A stable id already on file cannot be replaced or cleared through an ordinary edit.
          </small>
        </div>
        {props.mode === "create" && (
          <div className="field">
            <label>
              <input type="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} style={{ marginRight: 8 }} />
              Set as primary
            </label>
          </div>
        )}
      </div>

      {error && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      <div className="actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn" onClick={props.onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={saving || identityConflict || (props.mode === "create" && !platform.trim())}>
          {saving ? "Saving…" : props.mode === "create" ? "Create account" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
