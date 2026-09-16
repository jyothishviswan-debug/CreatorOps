"use client";

import { useState, type FormEvent } from "react";

import { Panel, PanelBody, PanelHead, PanelGrid } from "@/ui/Panel";
import { EmptyState, Skeleton } from "@/ui/States";
import { initialsOf } from "@/features/shared/types";
import { EffectiveAccessPanel } from "./EffectiveAccessPanel";
import { addSensitiveGrant, getEffectiveAccess, removeSensitiveGrant } from "./api-client";
import { ROLES, ROLE_LABELS, type Role } from "@/server/authz/roles";
import type { AdminUserDto } from "@/server/administration/types";
import type { EffectiveAccessDto } from "@/server/administration/effective-access-service";

export function AdministrationAccess({
  initialUsers,
  initialSensitiveByRole,
  initialSelectedUserRef,
  initialEffectiveAccess,
}: {
  initialUsers: AdminUserDto[];
  initialSensitiveByRole: Record<Role, string[]>;
  initialSelectedUserRef: string | null;
  initialEffectiveAccess: EffectiveAccessDto | null;
}) {
  const [selectedRole, setSelectedRole] = useState<Role>("super_admin");
  const [sensitiveByRole, setSensitiveByRole] = useState(initialSensitiveByRole);
  const [category, setCategory] = useState("");
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [selectedUserRef, setSelectedUserRef] = useState<string | null>(initialSelectedUserRef);
  const [effectiveAccess, setEffectiveAccess] = useState<EffectiveAccessDto | null>(initialEffectiveAccess);
  const [loadingAccess, setLoadingAccess] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);

  const filteredUsers = initialUsers.filter((user) => `${user.displayName} ${user.email}`.toLowerCase().includes(query.toLowerCase()));
  const categories = sensitiveByRole[selectedRole] ?? [];

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

  async function selectUser(userRef: string) {
    setSelectedUserRef(userRef);
    setLoadingAccess(true);
    setAccessError(null);
    const result = await getEffectiveAccess(userRef);
    setLoadingAccess(false);
    if (!result.ok) {
      setAccessError(result.error);
      setEffectiveAccess(null);
      return;
    }
    setEffectiveAccess(result.data);
  }

  return (
    <>
      <Panel>
        <PanelHead title="Sensitive-access categories by role" description="Role-keyed - distinct from feature/scope access. Managed here, per the canonical Step 4B model." />
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
                  {value}
                  <button type="button" aria-label={`Remove ${value}`} onClick={() => handleRemoveCategory(value)} style={{ padding: 0, lineHeight: 1 }}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          <form onSubmit={handleAddCategory} style={{ display: "flex", gap: 8, maxWidth: 360 }}>
            <input type="text" placeholder="e.g. finance_amounts" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="New sensitive category" />
            <button type="submit" className="btn" disabled={categoryBusy}>
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

      <PanelGrid>
        <Panel span={4}>
          <PanelHead title="Users" description="Select a user to inspect derived access." />
          <PanelBody>
            <input type="search" placeholder="Search name or email…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: "100%", marginBottom: 12 }} aria-label="Search users" />
            {filteredUsers.length === 0 ? (
              <EmptyState title="No matching users" />
            ) : (
              <div style={{ display: "grid", gap: 4 }}>
                {filteredUsers.map((user) => (
                  <button
                    key={user.userRef}
                    type="button"
                    className="rowlink person"
                    onClick={() => selectUser(user.userRef)}
                    style={{ width: "100%", padding: "8px 6px", borderRadius: 8, background: user.userRef === selectedUserRef ? "#fff1e8" : "transparent" }}
                  >
                    <span className="avatar">{initialsOf(user.displayName)}</span>
                    <span>
                      <b>{user.displayName}</b>
                      <small>{ROLE_LABELS[user.role]}</small>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </PanelBody>
        </Panel>

        {loadingAccess ? (
          <Panel span={8}>
            <PanelBody>
              <Skeleton lines={6} />
            </PanelBody>
          </Panel>
        ) : effectiveAccess ? (
          <EffectiveAccessPanel data={effectiveAccess} span={8} />
        ) : (
          <Panel span={8}>
            <PanelBody>
              <EmptyState title={accessError ?? "Select a user"} description={accessError ? undefined : "Choose a user from the list to inspect their derived access."} />
            </PanelBody>
          </Panel>
        )}
      </PanelGrid>
    </>
  );
}
