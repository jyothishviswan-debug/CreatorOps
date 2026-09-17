"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import { Icon } from "@/ui/icons";
import type { PartnerAccountDto } from "@/server/partners/client-dto";
import { createPartnerAccount, editPartnerAccount, listPartnerAccounts, setPartnerAccountStatus, setPrimaryPartnerAccount } from "./api-client";
import { relativeTime } from "./format";

export function PartnerAccountsPanel({ partnerRef, pendingSetup, onChanged }: { partnerRef: string; pendingSetup: boolean; onChanged?: () => void }) {
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

type AccountFormProps = { mode: "create"; partnerRef: string; onSaved: () => void; onCancel: () => void } | { mode: "edit"; account: PartnerAccountDto; onSaved: () => void; onCancel: () => void };

function AccountForm(props: AccountFormProps) {
  const initial = props.mode === "edit" ? props.account : null;
  const [platform, setPlatform] = useState(initial?.platform ?? "");
  const [handle, setHandle] = useState(initial?.handle ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [profileUrl, setProfileUrl] = useState(initial?.profileUrl ?? "");
  const [platformAccountId, setPlatformAccountId] = useState(initial?.platformAccountId ?? "");
  const [followerCount, setFollowerCount] = useState(initial?.followerSnapshot ? String(initial.followerSnapshot.count) : "");
  const [primary, setPrimary] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stableIdLocked = props.mode === "edit" && Boolean(initial?.platformAccountId);

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
      <div className="fields">
        <div className="field">
          <label>Platform</label>
          {props.mode === "create" ? (
            <input type="text" value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="Instagram" required />
          ) : (
            <input type="text" value={platform} disabled />
          )}
        </div>
        <div className="field">
          <label>Handle</label>
          <input type="text" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="handle" />
        </div>
        <div className="field">
          <label>Display name</label>
          <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="field">
          <label>Profile URL</label>
          <input type="url" value={profileUrl} onChange={(e) => setProfileUrl(e.target.value)} placeholder="https://instagram.com/handle" />
        </div>
        <div className="field">
          <label>Stable platform account id {stableIdLocked && "(locked once set)"}</label>
          <input type="text" value={platformAccountId} onChange={(e) => setPlatformAccountId(e.target.value)} disabled={stableIdLocked} />
          {stableIdLocked && <small>A stable id already on file cannot be replaced or cleared through an ordinary edit.</small>}
        </div>
        <div className="field">
          <label>Follower count</label>
          <input type="number" min={0} value={followerCount} onChange={(e) => setFollowerCount(e.target.value)} />
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
        <button type="submit" className="btn primary" disabled={saving || (props.mode === "create" && !platform.trim())}>
          {saving ? "Saving…" : props.mode === "create" ? "Create account" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
