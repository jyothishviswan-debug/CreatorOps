"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Toolbar, SearchInput } from "@/ui/Table";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import { initialsOf } from "@/features/shared/types";
import { ROLES, ROLE_LABELS, type Role } from "@/server/authz/roles";
import type { AdminUserDto } from "@/server/administration/types";
import type { UserListCursor } from "@/server/authz/firestore";
import { listUsers } from "./api-client";

const ROW_TINTS = ["#f5e9e1", "#e6edf5", "#f0eafa"];
const PAGE_SIZES = [10, 20, 50];

export function AdministrationUsersWorkspace({
  initialUsers,
  initialNextCursor,
  initialLimit,
}: {
  initialUsers: AdminUserDto[];
  initialNextCursor: UserListCursor | null;
  initialLimit: number;
}) {
  const router = useRouter();
  const [users, setUsers] = useState(initialUsers);
  const [cursor, setCursor] = useState(initialNextCursor);
  const [limit, setLimit] = useState(initialLimit);
  const [roleFilter, setRoleFilter] = useState<Role | "all">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [density, setDensity] = useState(false);
  const [layout, setLayout] = useState<"table" | "cards">("table");
  const skippedFirstEffect = useRef(false);

  useEffect(() => {
    // The initial page already arrived server-rendered as props (no
    // protected-data flash) - skip the redundant first fetch and only
    // re-query when a filter/page-size actually changes.
    if (!skippedFirstEffect.current) {
      skippedFirstEffect.current = true;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    listUsers({ limit, role: roleFilter === "all" ? undefined : roleFilter, active: statusFilter === "all" ? undefined : statusFilter === "active" }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setUsers(result.data.users);
      setCursor(result.data.nextCursor);
    });
    return () => {
      cancelled = true;
    };
  }, [limit, roleFilter, statusFilter]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    setError(null);
    const result = await listUsers({ limit, cursor, role: roleFilter === "all" ? undefined : roleFilter, active: statusFilter === "all" ? undefined : statusFilter === "active" });
    setLoadingMore(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setUsers((prev) => [...prev, ...result.data.users]);
    setCursor(result.data.nextCursor);
  }

  const filtered = users.filter((user) => `${user.displayName} ${user.email}`.toLowerCase().includes(query.toLowerCase()));

  function openUser(userRef: string) {
    router.push(`/administration/users/${userRef}`);
  }

  return (
    <section className="panel">
      <Toolbar>
        <SearchInput placeholder="Search name or email…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select aria-label="Filter role" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as Role | "all")}>
          <option value="all">All roles</option>
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
        <select aria-label="Filter status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "all" | "active" | "inactive")}>
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <select aria-label="Rows per page" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size} per page
            </option>
          ))}
        </select>
        <button className="btn" aria-pressed={density} type="button" onClick={() => setDensity((value) => !value)}>
          {density ? "Comfortable" : "Compact"} rows
        </button>
        <div className="segment">
          <button type="button" className={layout === "table" ? "active" : ""} onClick={() => setLayout("table")}>
            Table
          </button>
          <button type="button" className={layout === "cards" ? "active" : ""} onClick={() => setLayout("cards")}>
            Cards
          </button>
        </div>
      </Toolbar>

      {error && (
        <div className="banner" role="alert" style={{ margin: "0 18px 15px" }}>
          <b>Couldn&rsquo;t load users.</b> {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "0 18px 18px" }}>
          <Skeleton lines={5} />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={users.length === 0 ? "No users yet" : "No matching records"}
          description={users.length === 0 ? "Provision the first user to get started." : "Try another name, email, or clear the selected filters."}
          action={
            users.length === 0 ? (
              <Link href="/administration/users/new" className="btn primary">
                + New user
              </Link>
            ) : (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setQuery("");
                  setRoleFilter("all");
                  setStatusFilter("all");
                }}
              >
                Clear filters
              </button>
            )
          }
        />
      ) : layout === "cards" ? (
        <RecordCards rows={filtered} onOpen={openUser} />
      ) : (
        <RecordTable rows={filtered} density={density} onOpen={openUser} />
      )}

      <div className="panelfoot">
        <span>
          {filtered.length} of {users.length} loaded{cursor ? " · more available" : ""}
        </span>
        {cursor && (
          <button className="btn" type="button" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </section>
  );
}

function RecordCards({ rows, onOpen }: { rows: AdminUserDto[]; onOpen: (userRef: string) => void }) {
  return (
    <div className="recordgrid">
      {rows.map((user) => (
        <article className="record" key={user.userRef}>
          <button className="rowlink person" type="button" onClick={() => onOpen(user.userRef)}>
            <span className="avatar">{initialsOf(user.displayName)}</span>
            <span>
              <b>{user.displayName}</b>
              <small>{user.email}</small>
            </span>
          </button>
          <div style={{ marginTop: 13 }}>
            <Pill tone={user.active ? "default" : "red"}>{user.active ? "Active" : "Inactive"}</Pill>
          </div>
          <div className="recordmeta">
            <span>{ROLE_LABELS[user.role]}</span>
            <span>v{user.version}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function RecordTable({ rows, density, onOpen }: { rows: AdminUserDto[]; density: boolean; onOpen: (userRef: string) => void }) {
  return (
    <div className={density ? "tablewrap" : "tablewrap compact"}>
      <table>
        <caption className="sr">User directory</caption>
        <thead>
          <tr>
            <th>User</th>
            <th>Status</th>
            <th>Role</th>
            <th>
              <span className="sr">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((user, i) => (
            <tr key={user.userRef}>
              <td>
                <button className="rowlink person" type="button" onClick={() => onOpen(user.userRef)}>
                  <span className="avatar" style={{ background: ROW_TINTS[i % ROW_TINTS.length] }}>
                    {initialsOf(user.displayName)}
                  </span>
                  <span>
                    <b>{user.displayName}</b>
                    <small>{user.email}</small>
                  </span>
                </button>
              </td>
              <td>
                <Pill tone={user.active ? "default" : "red"}>{user.active ? "Active" : "Inactive"}</Pill>
              </td>
              <td>{ROLE_LABELS[user.role]}</td>
              <td>
                <button className="iconbutton" aria-label={`Inspect ${user.displayName}`} type="button" onClick={() => onOpen(user.userRef)}>
                  &rsaquo;
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
