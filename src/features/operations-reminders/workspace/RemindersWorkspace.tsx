"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { Toolbar, SearchInput } from "@/ui/Table";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import type { ReminderDto } from "@/server/operations/client-dto";
import { REMINDER_EFFECTIVE_STATUSES } from "@/server/operations/types";
import type { ReminderEffectiveStatus } from "@/server/operations/types";

import { listReminders } from "@/features/operations/api-client";
import { displayNameOrRef, REMINDER_STATUS_LABEL, REMINDER_STATUS_TONE, TARGET_TYPE_LABEL, formatDateTime } from "@/features/operations/copy";
import { targetLabel } from "@/features/operations/target-links";
import { useNarrowViewport } from "@/features/operations/use-narrow-viewport";

const ALL = "ALL";

export function RemindersWorkspace({ initialReminders, canManageReminders }: { initialReminders: ReminderDto[]; canManageReminders: boolean }) {
  const [reminders, setReminders] = useState(initialReminders);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<typeof ALL | ReminderEffectiveStatus>(ALL);
  const [owner, setOwner] = useState("");
  const [targetType, setTargetType] = useState(ALL);
  const [search, setSearch] = useState("");
  const narrow = useNarrowViewport();

  async function reload(nextOwner: string) {
    setLoading(true);
    setError(null);
    const result = await listReminders({ recipientUserRef: nextOwner.trim() || undefined, limit: 100 });
    setLoading(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setReminders(result.data.reminders);
  }

  useEffect(() => {
    const timer = setTimeout(() => void reload(owner), 250);
    return () => clearTimeout(timer);
  }, [owner]);

  const filtered = useMemo(
    () =>
      reminders.filter((r) => {
        if (status !== ALL && r.status !== status) return false;
        if (targetType !== ALL && r.target.targetType !== targetType) return false;
        if (search.trim()) {
          const q = search.trim().toLowerCase();
          if (!`${r.message} ${r.reminderRef} ${r.target.targetRef}`.toLowerCase().includes(q)) return false;
        }
        return true;
      }),
    [reminders, status, targetType, search],
  );

  function resetFilters() {
    setStatus(ALL);
    setOwner("");
    setTargetType(ALL);
    setSearch("");
    void reload("");
  }

  const summary = useMemo(() => {
    const counts = { scheduled: 0, due: 0, dismissed: 0, completed: 0 };
    for (const r of reminders) {
      if (r.status === "SCHEDULED") counts.scheduled += 1;
      if (r.status === "DUE") counts.due += 1;
      if (r.status === "DISMISSED") counts.dismissed += 1;
      if (r.status === "COMPLETED") counts.completed += 1;
    }
    return counts;
  }, [reminders]);

  return (
    <>
      <div className="panel" style={{ marginBottom: 14 }} data-testid="reminders-status-strip">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 0 }}>
          {[
            { label: "Scheduled", value: summary.scheduled },
            { label: "Due", value: summary.due },
            { label: "Dismissed", value: summary.dismissed },
            { label: "Completed", value: summary.completed },
          ].map((item, index) => (
            <div key={item.label} style={{ flex: "1 1 130px", padding: "14px 18px", borderRight: index < 3 ? "1px solid var(--line)" : undefined, minWidth: 120 }}>
              <small className="muted" style={{ display: "block", marginBottom: 4 }}>
                {item.label}
              </small>
              <b style={{ fontSize: 20, letterSpacing: "-0.5px" }}>{item.value}</b>
            </div>
          ))}
        </div>
        <p className="foundationnote" style={{ padding: "0 18px 12px", margin: 0 }}>
          Counts are of the current bounded Reminders read, not a total.
        </p>
      </div>

      <section className="panel" aria-busy={loading}>
        <Toolbar>
          <select aria-label="Status" style={{ width: 150 }} value={status} onChange={(e) => setStatus(e.target.value as typeof ALL | ReminderEffectiveStatus)}>
            <option value={ALL}>All statuses</option>
            {REMINDER_EFFECTIVE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {REMINDER_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <div className="inputwrap" style={{ minWidth: 180 }}>
            <input type="search" aria-label="Owner user ref" placeholder="Owner user ref…" value={owner} onChange={(e) => setOwner(e.target.value)} />
          </div>
          <select aria-label="Target type" style={{ width: 160 }} value={targetType} onChange={(e) => setTargetType(e.target.value)}>
            <option value={ALL}>All target types</option>
            {Object.entries(TARGET_TYPE_LABEL).map(([type, label]) => (
              <option key={type} value={type}>
                {label}
              </option>
            ))}
          </select>
          <SearchInput aria-label="Search reminders" placeholder="Search message or ref…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button type="button" className="btn ghost" onClick={resetFilters}>
            Reset
          </button>
        </Toolbar>

        {error && (
          <div className="banner" role="alert" style={{ margin: "0 18px 10px" }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ padding: "0 18px 18px" }} aria-hidden="true">
            <Skeleton lines={5} />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState title="No reminders match these filters" description="Try clearing filters, or create a new reminder." action={<button className="btn" type="button" onClick={resetFilters}>Clear filters</button>} />
        ) : narrow ? (
          <ReminderCards rows={filtered} />
        ) : (
          <RemindersTable rows={filtered} />
        )}

        <div className="panelfoot">
          <span>{filtered.length} reminder(s) shown</span>
          {canManageReminders && (
            <Link className="btn" href="/operations/reminders/new">
              Create Reminder
            </Link>
          )}
        </div>
      </section>
    </>
  );
}

function RemindersTable({ rows }: { rows: ReminderDto[] }) {
  return (
    <div className="tablewrap" data-testid="reminders-table">
      <table className="compact">
        <caption className="sr">Reminders workspace</caption>
        <thead>
          <tr>
            <th scope="col">Reminder</th>
            <th scope="col">Target</th>
            <th scope="col">Owner</th>
            <th scope="col">Reminder time</th>
            <th scope="col">Status</th>
            <th scope="col">Source</th>
            <th scope="col">Updated</th>
            <th scope="col">
              <span className="sr">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.reminderRef} data-testid="reminder-row" data-reminder-ref={r.reminderRef}>
              <td style={{ maxWidth: 260, overflowWrap: "anywhere" }}>
                <b>{r.message}</b>
                <small style={{ display: "block" }}>{r.reminderRef}</small>
              </td>
              <td style={{ overflowWrap: "anywhere" }}>{targetLabel(r.target)}</td>
              <td style={{ overflowWrap: "anywhere" }}>{displayNameOrRef(r.recipientDisplayName, r.recipientUserRef)}</td>
              <td>{formatDateTime(r.reminderAt)}</td>
              <td>
                <Pill tone={REMINDER_STATUS_TONE[r.status]}>{REMINDER_STATUS_LABEL[r.status]}</Pill>
              </td>
              <td>{r.taskRef ? "Linked task" : r.approvalItemRef ? "Approval follow-up" : "Manual"}</td>
              <td>{formatDateTime(r.updatedAt)}</td>
              <td>
                <Link className="btn" href={`/operations/reminders/${encodeURIComponent(r.reminderRef)}`} data-testid="open-reminder">
                  Open
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReminderCards({ rows }: { rows: ReminderDto[] }) {
  return (
    <div className="recordgrid" data-testid="reminders-cards">
      {rows.map((r) => (
        <article className="record" key={r.reminderRef} data-testid="reminder-card" data-reminder-ref={r.reminderRef}>
          <b>{r.message}</b>
          <small style={{ display: "block", marginBottom: 8 }}>{r.reminderRef}</small>
          <div style={{ marginBottom: 10 }}>
            <Pill tone={REMINDER_STATUS_TONE[r.status]}>{REMINDER_STATUS_LABEL[r.status]}</Pill>
          </div>
          <div className="recordmeta">
            <span>{targetLabel(r.target)}</span>
            <span>{formatDateTime(r.reminderAt)}</span>
          </div>
          <div style={{ marginTop: 12 }}>
            <Link className="btn" style={{ width: "100%" }} href={`/operations/reminders/${encodeURIComponent(r.reminderRef)}`} data-testid="open-reminder">
              Open
            </Link>
          </div>
        </article>
      ))}
    </div>
  );
}
