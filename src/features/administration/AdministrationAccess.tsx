"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Panel, PanelBody, PanelHead, PanelGrid } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import { initialsOf } from "@/features/shared/types";
import { AccessMatrix } from "./AccessMatrix";
import { getEffectiveAccess, addSensitiveGrant, listUsers, removeSensitiveGrant } from "./api-client";
import { FEATURES } from "@/server/authz/features";
import { ROLES, ROLE_LABELS, type Role } from "@/server/authz/roles";
import { SENSITIVE_CATEGORIES } from "@/server/authz/sensitive-categories";
import type { AdminUserDto } from "@/server/administration/types";
import type { EffectiveAccessDto } from "@/server/administration/effective-access-service";

export function AdministrationAccess({
  initialSensitiveByRole,
  initialSelectedUser,
  initialEffectiveAccess,
}: {
  initialSensitiveByRole: Record<Role, string[]>;
  initialSelectedUser: AdminUserDto | null;
  initialEffectiveAccess: EffectiveAccessDto | null;
}) {
  const router = useRouter();
  const [selectedRole, setSelectedRole] = useState<Role>("super_admin");
  const [sensitiveByRole, setSensitiveByRole] = useState(initialSensitiveByRole);
  const [category, setCategory] = useState("");
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<AdminUserDto[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [selectedUser, setSelectedUser] = useState<AdminUserDto | null>(initialSelectedUser);
  const [effectiveAccess, setEffectiveAccess] = useState<EffectiveAccessDto | null>(initialEffectiveAccess);
  const [loadingAccess, setLoadingAccess] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);

  const categories = sensitiveByRole[selectedRole] ?? [];

  const trimmedQuery = searchQuery.trim();
  // Fewer than 2 characters shows nothing, derived at render time rather
  // than by clearing state from inside the effect below.
  const displayResults = trimmedQuery.length < 2 ? [] : searchResults;

  // Search-first: nothing loads until at least 2 characters are typed - a
  // bounded, indexed email-prefix query, not a filter over a preloaded
  // list of everyone.
  useEffect(() => {
    if (trimmedQuery.length < 2) return;
    let cancelled = false;
    const timeout = setTimeout(async () => {
      setSearching(true);
      const result = await listUsers({ emailPrefix: trimmedQuery.toLowerCase(), limit: 8 });
      if (cancelled) return;
      setSearching(false);
      if (!result.ok) {
        setSearchError(result.error);
        return;
      }
      setSearchError(null);
      setSearchResults(result.data.users);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [trimmedQuery]);

  async function handleAddCategory(e: FormEvent) {
    e.preventDefault();
    const trimmed = category.trim();
    if (!trimmed) return;
    setCategoryBusy(true);
    setCategoryError(null);
    const result = await addSensitiveGrant(selectedRole, { category: trimmed });
    setCategoryBusy(false);
    if (!result.ok) {
      setCategoryError(result.error);
      return;
    }
    setSensitiveByRole((prev) => ({ ...prev, [selectedRole]: result.data.categories }));
    setCategory("");
  }

  async function handleRemoveCategory(value: string) {
    if (!window.confirm(`Remove sensitive category "${value}" from ${ROLE_LABELS[selectedRole]}?`)) return;
    setCategoryError(null);
    const result = await removeSensitiveGrant(selectedRole, { category: value });
    if (!result.ok) {
      setCategoryError(result.error);
      return;
    }
    setSensitiveByRole((prev) => ({ ...prev, [selectedRole]: result.data.categories }));
  }

  async function selectUser(user: AdminUserDto) {
    setSelectedUser(user);
    setSearchQuery("");
    setSearchResults([]);
    setLoadingAccess(true);
    setAccessError(null);
    // Reflected in the URL so a refresh (or sharing the link, or arriving
    // from a user's own detail page) lands on the same selection - not
    // just component state that a reload would silently drop.
    router.replace(`/administration/access?user=${user.userRef}`, { scroll: false });
    const result = await getEffectiveAccess(user.userRef);
    setLoadingAccess(false);
    if (!result.ok) {
      setAccessError(result.error);
      setEffectiveAccess(null);
      return;
    }
    setEffectiveAccess(result.data);
  }

  async function refreshSelectedUser() {
    if (!selectedUser) return;
    const result = await getEffectiveAccess(selectedUser.userRef);
    if (result.ok) setEffectiveAccess(result.data);
  }

  return (
    <>
      <Panel>
        <PanelHead
          title="Sensitive-access categories by role"
          description="A distinct gate from module/feature access - e.g. Partnership Manager can view Finance, but only a role granted the finance_amounts category here can see sensitive amounts within it. Role-keyed, not per-user."
        />
        <PanelBody>
          <div className="segment" style={{ marginBottom: 16, flexWrap: "wrap" }}>
            {ROLES.map((role) => (
              <button key={role} type="button" className={role === selectedRole ? "active" : ""} onClick={() => setSelectedRole(role)}>
                {ROLE_LABELS[role]}
              </button>
            ))}
          </div>

          {categories.length === 0 ? (
            <small>No sensitive categories granted to {ROLE_LABELS[selectedRole]}.</small>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
              {categories.map((value) => (
                <span key={value} className="pill purple" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {SENSITIVE_CATEGORIES.find((c) => c.id === value)?.label ?? value}
                  <button type="button" aria-label={`Remove ${value}`} onClick={() => handleRemoveCategory(value)} style={{ padding: 0, lineHeight: 1 }}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          <form onSubmit={handleAddCategory} style={{ display: "flex", gap: 8, maxWidth: 360 }}>
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="New sensitive category">
              <option value="">Select a category…</option>
              {SENSITIVE_CATEGORIES.filter((c) => !categories.includes(c.id)).map((c) => (
                <option key={c.id} value={c.id} title={c.description}>
                  {c.label}
                </option>
              ))}
            </select>
            <button type="submit" className="btn" disabled={categoryBusy || !category}>
              {categoryBusy ? "Adding…" : "+ Add"}
            </button>
          </form>
          {categoryError && (
            <div className="banner" role="alert" style={{ marginTop: 10 }}>
              {categoryError}
            </div>
          )}
        </PanelBody>
      </Panel>

      <div style={{ margin: "28px 0 18px" }} className="sectionlabel">
        <span>USER ACCESS</span>
        <p>Find one user to inspect and edit their module/action overrides.</p>
      </div>

      <Panel>
        <PanelHead title="Find a user" description="Search by email - results appear as you type, nothing is listed until you search." />
        <PanelBody>
          <input
            type="search"
            placeholder="Search by email (e.g. manager@creatorops.com)…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ width: "100%", maxWidth: 420 }}
            aria-label="Search users by email"
          />

          {searchError && (
            <div className="banner" role="alert" style={{ marginTop: 10 }}>
              {searchError}
            </div>
          )}

          {searching ? (
            <div style={{ marginTop: 14 }}>
              <Skeleton lines={2} />
            </div>
          ) : displayResults.length > 0 ? (
            <div style={{ display: "grid", gap: 4, marginTop: 14, maxWidth: 420 }}>
              {displayResults.map((user) => (
                <button key={user.userRef} type="button" className="rowlink person" style={{ width: "100%", padding: "8px 6px", borderRadius: 8 }} onClick={() => selectUser(user)}>
                  <span className="avatar">{initialsOf(user.displayName)}</span>
                  <span>
                    <b>{user.displayName}</b>
                    <small>
                      {user.email} · {ROLE_LABELS[user.role]}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          ) : trimmedQuery.length >= 2 ? (
            <small style={{ display: "block", marginTop: 14 }}>No users match that email.</small>
          ) : null}
        </PanelBody>
      </Panel>

      {selectedUser && (
        <>
          <PanelGrid>
            {loadingAccess ? (
              <Panel span={12}>
                <PanelBody>
                  <Skeleton lines={4} />
                </PanelBody>
              </Panel>
            ) : effectiveAccess ? (
              <Panel span={12}>
                <PanelHead title={selectedUser.displayName} description={selectedUser.email} />
                <PanelBody>
                  <div className="fields">
                    <div className="kv">
                      <span>Base role</span>
                      <b>{ROLE_LABELS[effectiveAccess.role]}</b>
                    </div>
                    <div className="kv">
                      <span>Status</span>
                      <Pill tone={effectiveAccess.active ? "default" : "red"}>{effectiveAccess.active ? "Active" : "Inactive"}</Pill>
                    </div>
                    <div className="kv">
                      <span>Effective modules</span>
                      <b>
                        {effectiveAccess.activeFeatures.length} of {FEATURES.length}
                      </b>
                    </div>
                    <div className="kv">
                      <span>Sensitive categories</span>
                      <b>{effectiveAccess.sensitiveCategories.length > 0 ? effectiveAccess.sensitiveCategories.join(", ") : "None"}</b>
                    </div>
                  </div>
                </PanelBody>
              </Panel>
            ) : (
              <Panel span={12}>
                <PanelBody>
                  <EmptyState title={accessError ?? "Couldn't load this user's access"} />
                </PanelBody>
              </Panel>
            )}
          </PanelGrid>

          {effectiveAccess && <AccessMatrix userRef={selectedUser.userRef} data={effectiveAccess} onRefresh={refreshSelectedUser} />}
        </>
      )}
    </>
  );
}
