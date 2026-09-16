"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";

import { Panel, PanelBody, PanelHead, PanelGrid } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { EmptyState } from "@/ui/States";
import { EffectiveAccessPanel } from "./EffectiveAccessPanel";
import { scopeChips } from "./format";
import { addScopeGrant, getEffectiveAccess, removeScopeGrant, updateUser } from "./api-client";
import { ROLES, ROLE_LABELS, type Role } from "@/server/authz/roles";
import type { AdminUserDto } from "@/server/administration/types";
import type { EffectiveAccessDto } from "@/server/administration/effective-access-service";
import type { ScopeGrantRequestInput } from "@/server/administration/scope-grants-service";

type GrantType = ScopeGrantRequestInput["type"];

const GRANT_TYPES: { value: GrantType; label: string }[] = [
  { value: "SELF", label: "Self" },
  { value: "GLOBAL", label: "Global" },
  { value: "REGION", label: "Region" },
  { value: "TEAM", label: "Team" },
  { value: "PARTNER", label: "Partner" },
  { value: "CAMPAIGN", label: "Campaign" },
  { value: "EXPLICIT_RECORD", label: "Explicit record" },
  { value: "ANALYTICS_DATASET", label: "Analytics dataset" },
  { value: "ANALYTICS_ACCOUNT", label: "Analytics account" },
];

function buildGrant(type: GrantType, discriminator: string, discriminator2: string): ScopeGrantRequestInput | null {
  switch (type) {
    case "SELF":
    case "GLOBAL":
      return { type };
    case "REGION":
      return discriminator ? { type, region: discriminator } : null;
    case "TEAM":
      return discriminator ? { type, teamId: discriminator } : null;
    case "PARTNER":
      return discriminator ? { type, partnerId: discriminator } : null;
    case "CAMPAIGN":
      return discriminator ? { type, campaignId: discriminator } : null;
    case "ANALYTICS_DATASET":
      return discriminator ? { type, datasetId: discriminator } : null;
    case "ANALYTICS_ACCOUNT":
      return discriminator ? { type, accountId: discriminator } : null;
    case "EXPLICIT_RECORD":
      return discriminator && discriminator2 ? { type, resourceType: discriminator, resourceId: discriminator2 } : null;
  }
}

export function AdminUserDetail({ initialUser, initialEffectiveAccess }: { initialUser: AdminUserDto; initialEffectiveAccess: EffectiveAccessDto | null }) {
  const [user, setUser] = useState(initialUser);
  const [effectiveAccess, setEffectiveAccess] = useState(initialEffectiveAccess);
  const [effectiveAccessError, setEffectiveAccessError] = useState<string | null>(initialEffectiveAccess ? null : "Couldn't load effective access.");

  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState<Role>(user.role);
  const [active, setActive] = useState(user.active);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const [grantType, setGrantType] = useState<GrantType>("REGION");
  const [discriminator, setDiscriminator] = useState("");
  const [discriminator2, setDiscriminator2] = useState("");
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);

  const dirty = displayName !== user.displayName || role !== user.role || active !== user.active;

  async function refreshEffectiveAccess() {
    const result = await getEffectiveAccess(user.userRef);
    if (result.ok) {
      setEffectiveAccess(result.data);
      setEffectiveAccessError(null);
    } else {
      setEffectiveAccessError(result.error);
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!dirty) return;

    if (!active && user.active) {
      if (!window.confirm(`Deactivate ${user.displayName}? They will lose all access immediately.`)) return;
    }
    if (role !== user.role && (role === "super_admin" || user.role === "super_admin")) {
      if (!window.confirm(`Change ${user.displayName}'s role from ${ROLE_LABELS[user.role]} to ${ROLE_LABELS[role]}? This affects Super Admin standing.`)) return;
    }

    setSaving(true);
    setSaveError(null);
    setStale(false);

    const patch: { displayName?: string; role?: Role; active?: boolean; expectedVersion: number } = { expectedVersion: user.version };
    if (displayName !== user.displayName) patch.displayName = displayName;
    if (role !== user.role) patch.role = role;
    if (active !== user.active) patch.active = active;

    const result = await updateUser(user.userRef, patch);
    setSaving(false);

    if (!result.ok) {
      if (result.code === "conflict" && result.status === 409 && result.error.toLowerCase().includes("modified")) {
        setStale(true);
      } else {
        setSaveError(result.error);
      }
      return;
    }

    setUser(result.data);
    setDisplayName(result.data.displayName);
    setRole(result.data.role);
    setActive(result.data.active);
    void refreshEffectiveAccess();
  }

  async function reload() {
    window.location.reload();
  }

  async function handleAddGrant(e: FormEvent) {
    e.preventDefault();
    const grant = buildGrant(grantType, discriminator.trim(), discriminator2.trim());
    if (!grant) {
      setGrantError("Fill in the required field(s) for this grant type.");
      return;
    }
    if (grantType === "GLOBAL" && !window.confirm(`Grant GLOBAL scope to ${user.displayName}? This allows access to every record system-wide.`)) return;

    setGrantBusy(true);
    setGrantError(null);
    const result = await addScopeGrant(user.userRef, grant);
    setGrantBusy(false);
    if (!result.ok) {
      setGrantError(result.error);
      return;
    }
    setDiscriminator("");
    setDiscriminator2("");
    void refreshEffectiveAccess();
  }

  async function handleRemoveGrant(grant: ScopeGrantRequestInput, label: string) {
    if (!window.confirm(`Remove ${label} scope from ${user.displayName}?`)) return;
    setGrantError(null);
    const result = await removeScopeGrant(user.userRef, grant);
    if (!result.ok) {
      setGrantError(result.error);
      return;
    }
    void refreshEffectiveAccess();
  }

  const chips = effectiveAccess ? scopeChips(effectiveAccess.scope) : [];

  function grantForChip(kind: string, label: string): ScopeGrantRequestInput | null {
    if (kind === "global") return label === "Global" ? { type: "GLOBAL" } : null;
    if (kind === "self") return { type: "SELF" };
    if (kind === "region") return { type: "REGION", region: label.replace("Region: ", "") };
    if (kind === "team") return { type: "TEAM", teamId: label.replace("Team: ", "") };
    if (kind === "partner") return { type: "PARTNER", partnerId: label.replace("Partner: ", "") };
    if (kind === "campaign") return { type: "CAMPAIGN", campaignId: label.replace("Campaign: ", "") };
    if (kind === "dataset") return { type: "ANALYTICS_DATASET", datasetId: label.replace("Dataset: ", "") };
    if (kind === "account") return { type: "ANALYTICS_ACCOUNT", accountId: label.replace("Analytics account: ", "") };
    return null;
  }

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">USERS / RECORD DETAIL</div>
          <h1>{user.displayName}</h1>
          <p>{user.email}</p>
        </div>
        <div className="actions">
          <Link href="/administration/users" className="btn">
            Back to users
          </Link>
        </div>
      </div>

      <div className="detailcontext">
        <div>
          <small>Status</small>
          <Pill tone={user.active ? "default" : "red"}>{user.active ? "Active" : "Inactive"}</Pill>
        </div>
        <div>
          <small>Role</small>
          <b>{ROLE_LABELS[user.role]}</b>
        </div>
        <div>
          <small>Version</small>
          <b>v{user.version}</b>
        </div>
        <div>
          <small>User reference</small>
          <b style={{ fontFamily: "monospace", fontSize: 11 }}>{user.userRef}</b>
        </div>
      </div>

      {stale && (
        <div className="banner" role="alert">
          <b>This user was modified elsewhere.</b> Reload to see the latest version before saving again.
          <button className="btn" type="button" onClick={reload} style={{ marginLeft: 10 }}>
            Reload
          </button>
        </div>
      )}

      <PanelGrid>
        <Panel span={8}>
          <PanelHead title="Profile" description="Display name, role and admission status." />
          <PanelBody>
            <form onSubmit={handleSave}>
              <div className="fields">
                <div className="field">
                  <label htmlFor="profile-display-name">Display name</label>
                  <input id="profile-display-name" type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
                </div>
                <div className="field">
                  <label htmlFor="profile-role">Role</label>
                  <select id="profile-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="profile-active">Admission status</label>
                  <select id="profile-active" value={active ? "active" : "inactive"} onChange={(e) => setActive(e.target.value === "active")}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>

              {saveError && (
                <div className="banner" role="alert" style={{ marginTop: 14 }}>
                  <b>Couldn&rsquo;t save.</b> {saveError}
                </div>
              )}

              <div className="formfoot" style={{ margin: "18px -20px -18px", borderRadius: "0 0 var(--radius) var(--radius)" }}>
                <small>{dirty ? "Unsaved changes" : "No changes to save"}</small>
                <button type="submit" className="btn primary" disabled={!dirty || saving}>
                  {saving ? "Saving…" : "Save changes"}
                </button>
              </div>
            </form>
          </PanelBody>
        </Panel>

        <Panel span={4}>
          <PanelHead title="Scope grants" description="Canonical Step 4C scope model." />
          <PanelBody>
            {chips.length === 0 ? (
              <EmptyState title="No scope grants" description="This user cannot reach any records yet." />
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
                {chips.map((chip) => {
                  const grant = grantForChip(chip.kind, chip.label);
                  return (
                    <span key={chip.label} className={`pill${chip.kind === "global" ? " orange" : " gray"}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      {chip.label}
                      {grant && (
                        <button type="button" aria-label={`Remove ${chip.label}`} onClick={() => handleRemoveGrant(grant, chip.label)} style={{ padding: 0, lineHeight: 1 }}>
                          ✕
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
            )}

            <form onSubmit={handleAddGrant}>
              <div className="fields" style={{ gridTemplateColumns: "1fr" }}>
                <div className="field">
                  <label htmlFor="grant-type">Grant type</label>
                  <select
                    id="grant-type"
                    value={grantType}
                    onChange={(e) => {
                      setGrantType(e.target.value as GrantType);
                      setDiscriminator("");
                      setDiscriminator2("");
                    }}
                  >
                    {GRANT_TYPES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                {grantType !== "SELF" && grantType !== "GLOBAL" && (
                  <div className="field">
                    <label htmlFor="grant-discriminator">
                      {grantType === "REGION" && "Region"}
                      {grantType === "TEAM" && "Team id"}
                      {grantType === "PARTNER" && "Partner id"}
                      {grantType === "CAMPAIGN" && "Campaign id"}
                      {grantType === "ANALYTICS_DATASET" && "Dataset id"}
                      {grantType === "ANALYTICS_ACCOUNT" && "Account id"}
                      {grantType === "EXPLICIT_RECORD" && "Resource type"}
                    </label>
                    <input id="grant-discriminator" type="text" value={discriminator} onChange={(e) => setDiscriminator(e.target.value)} />
                  </div>
                )}
                {grantType === "EXPLICIT_RECORD" && (
                  <div className="field">
                    <label htmlFor="grant-discriminator-2">Resource id</label>
                    <input id="grant-discriminator-2" type="text" value={discriminator2} onChange={(e) => setDiscriminator2(e.target.value)} />
                  </div>
                )}
              </div>
              {grantError && (
                <div className="banner" role="alert" style={{ marginTop: 10 }}>
                  {grantError}
                </div>
              )}
              <button type="submit" className="btn" disabled={grantBusy} style={{ marginTop: 12, width: "100%" }}>
                {grantBusy ? "Adding…" : "+ Add scope grant"}
              </button>
            </form>
          </PanelBody>
        </Panel>
      </PanelGrid>

      {effectiveAccess ? (
        <PanelGrid>
          <EffectiveAccessPanel data={effectiveAccess} span={12} />
        </PanelGrid>
      ) : (
        <section className="panel">
          <EmptyState title="Effective access unavailable" description={effectiveAccessError ?? "Couldn't load effective access."} />
        </section>
      )}
    </>
  );
}
