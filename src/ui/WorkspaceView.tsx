"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Toolbar, SearchInput } from "./Table";
import { Pill } from "./Badge";
import { EmptyState } from "./States";
import type { ModuleWorkspace, RecordRow, Tone } from "@/features/shared/types";
import { statusTone } from "@/features/shared/types";

const ROW_TINTS = ["#f5e9e1", "#e6edf5", "#f0eafa"];

function pillTone(tone: Tone): "default" | "orange" | "blue" | "purple" | "red" | "gray" {
  if (tone === "green") return "default";
  return tone;
}

export function WorkspaceView({ workspace, basePath }: { workspace: ModuleWorkspace; basePath?: string }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All statuses");
  const [density, setDensity] = useState(false);
  const [layout, setLayout] = useState<"table" | "cards">("table");

  const statuses = useMemo(() => [...new Set(workspace.rows.map((r) => r.status))], [workspace.rows]);
  const filtered = useMemo(
    () =>
      workspace.rows.filter(
        (r) =>
          `${r.name} ${r.sub} ${r.region} ${r.type}`.toLowerCase().includes(query.toLowerCase()) &&
          (status === "All statuses" || r.status === status),
      ),
    [workspace.rows, query, status],
  );

  const openRecord = basePath ? (id: string) => router.push(`${basePath}/${id}`) : undefined;

  return (
    <section className="panel">
      <Toolbar>
        <SearchInput
          placeholder="Search names, context or region…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select aria-label="Filter status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option>All statuses</option>
          {statuses.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <button className="btn" aria-pressed={density} type="button" onClick={() => setDensity((d) => !d)}>
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

      {filtered.length === 0 ? (
        <EmptyState
          title="No matching records"
          description="Try another name or clear the selected filters."
          action={
            <button
              className="btn"
              type="button"
              onClick={() => {
                setQuery("");
                setStatus("All statuses");
              }}
            >
              Clear filters
            </button>
          }
        />
      ) : layout === "cards" ? (
        <RecordCards rows={filtered} onOpen={openRecord} />
      ) : (
        <RecordTable rows={filtered} columns={workspace.columns} density={density} onOpen={openRecord} />
      )}

      <div className="panelfoot">
        <span>{filtered.length} sample records · all results shown</span>
        <span>No live data connection</span>
      </div>
    </section>
  );
}

function RecordCards({ rows, onOpen }: { rows: RecordRow[]; onOpen?: (id: string) => void }) {
  return (
    <div className="recordgrid">
      {rows.map((r) => (
        <article className="record" key={r.id}>
          {onOpen ? (
            <button className="rowlink person" type="button" onClick={() => onOpen(r.id)}>
              <span className="avatar">{r.initials}</span>
              <span>
                <b>{r.name}</b>
                <small>{r.sub}</small>
              </span>
            </button>
          ) : (
            <span className="person">
              <span className="avatar">{r.initials}</span>
              <span>
                <b>{r.name}</b>
                <small>{r.sub}</small>
              </span>
            </span>
          )}
          <div style={{ marginTop: 13 }}>
            <Pill tone={pillTone(statusTone(r.status))}>{r.status}</Pill>
          </div>
          <div className="recordmeta">
            <span>{r.region}</span>
            <span>{r.type}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function RecordTable({
  rows,
  columns,
  density,
  onOpen,
}: {
  rows: RecordRow[];
  columns: ModuleWorkspace["columns"];
  density: boolean;
  onOpen?: (id: string) => void;
}) {
  return (
    <div className={density ? "tablewrap" : "tablewrap compact"}>
      <table>
        <caption className="sr">{columns.record} illustrative workspace records</caption>
        <thead>
          <tr>
            <th>{columns.record}</th>
            <th>{columns.status}</th>
            <th>{columns.context}</th>
            <th>{columns.region}</th>
            <th>{columns.owner}</th>
            {onOpen && (
              <th>
                <span className="sr">Action</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id}>
              <td>
                {onOpen ? (
                  <button className="rowlink person" type="button" onClick={() => onOpen(r.id)}>
                    <span className="avatar" style={{ background: ROW_TINTS[i % ROW_TINTS.length] }}>
                      {r.initials}
                    </span>
                    <span>
                      <b>{r.name}</b>
                      <small>{r.sub}</small>
                    </span>
                  </button>
                ) : (
                  <span className="person">
                    <span className="avatar" style={{ background: ROW_TINTS[i % ROW_TINTS.length] }}>
                      {r.initials}
                    </span>
                    <span>
                      <b>{r.name}</b>
                      <small>{r.sub}</small>
                    </span>
                  </span>
                )}
              </td>
              <td>
                <Pill tone={pillTone(statusTone(r.status))}>{r.status}</Pill>
              </td>
              <td>{r.type}</td>
              <td>{r.region}</td>
              <td>{r.owner}</td>
              {onOpen && (
                <td>
                  <button className="iconbutton" aria-label={`Inspect ${r.name}`} type="button" onClick={() => onOpen(r.id)}>
                    &rsaquo;
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
