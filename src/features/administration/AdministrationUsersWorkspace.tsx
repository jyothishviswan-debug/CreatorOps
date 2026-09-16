"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Toolbar, SearchInput } from "@/ui/Table";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import { initialsOf } from "@/features/shared/types";
import { Pager } from "./Pager";
import { ROLES, ROLE_LABELS, type Role } from "@/server/authz/roles";
import type { AdminUserDto } from "@/server/administration/types";
import type { UserListCursor } from "@/server/authz/firestore";
import { listUsers } from "./api-client";

const ROW_TINTS = ["#f5e9e1", "#e6edf5", "#f0eafa"];
const PAGE_SIZE = 10;

export function AdministrationUsersWorkspace({ initialUsers, initialNextCursor }: { initialUsers: AdminUserDto[]; initialNextCursor: UserListCursor | null }) {
  const router = useRouter();
  // pages[i] is page i+1's rows; nextCursors[i] is the cursor to fetch
  // page i+2 (i.e. the cursor returned when page i+1 was fetched).
  const [pages, setPages] = useState<AdminUserDto[][]>([initialUsers]);
  const [nextCursors, setNextCursors] = useState<(UserListCursor | null)[]>([initialNextCursor]);
  const [currentPage, setCurrentPage] = useState(1);
  const [roleFilter, setRoleFilter] = useState<Role | "all">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [density, setDensity] = useState(false);
  const [layout, setLayout] = useState<"table" | "cards">("table");
  const skippedFirstEffect = useRef(false);

  const filters = { role: roleFilter === "all" ? undefined : roleFilter, active: statusFilter === "all" ? undefined : statusFilter === "active" };

  useEffect(() => {
    // The initial page already arrived server-rendered as props (no
    // protected-data flash) - skip the redundant first fetch and only
    // re-query when a filter actually changes.
    if (!skippedFirstEffect.current) {
      skippedFirstEffect.current = true;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    listUsers({ limit: PAGE_SIZE, ...filters }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPages([result.data.users]);
      setNextCursors([result.data.nextCursor]);
      setCurrentPage(1);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleFilter, statusFilter]);

  async function goToPage(page: number) {
    if (page < 1 || page === currentPage) return;
    if (page <= pages.length) {
      setCurrentPage(page);
      return;
    }
    // Fetching the next not-yet-visited page: continue from the cursor
    // the previous page returned.
    const cursor = nextCursors[page - 2];
    if (page > pages.length + 1 || cursor === undefined || cursor === null) return;
    setLoading(true);
    setError(null);
    const result = await listUsers({ limit: PAGE_SIZE, cursor, ...filters });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPages((prev) => [...prev, result.data.users]);
    setNextCursors((prev) => [...prev, result.data.nextCursor]);
    setCurrentPage(page);
  }

  const rows = pages[currentPage - 1] ?? [];
  const filtered = rows.filter((user) => `${user.displayName} ${user.email}`.toLowerCase().includes(query.toLowerCase()));
  const hasMore = nextCursors[currentPage - 1] != null;

  function openUser(userRef: string) {
    router.push(`/administration/users/${userRef}`);
  }

  return (
    <section className="panel">
      <Toolbar>
        <SearchInput placeholder="Filter this page by name or email…" value={query} onChange={(e) => setQuery(e.target.value)} />
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
          title={rows.length === 0 ? "No users yet" : "No matching records on this page"}
          description={rows.length === 0 ? "Provision the first user to get started." : "Try another name/email, or check another page."}
          action={
            rows.length === 0 ? (
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
          Page {currentPage} · {filtered.length} shown
        </span>
        <Pager currentPage={currentPage} knownPages={pages.length} hasMore={hasMore} busy={loading} onChange={goToPage} />
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
