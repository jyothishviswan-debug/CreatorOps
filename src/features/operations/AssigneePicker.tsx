"use client";

import { useEffect, useState } from "react";

import { Icon } from "@/ui/icons";

import { searchActiveUsers, type AdminUserOption } from "./api-client";

const SEARCH_DEBOUNCE_MS = 300;

// Step 18B: the reusable assignee/recipient picker. Active/admitted CreatorOps users only (Step 18A's
// requireAdmittedActiveUser re-checks this server-side regardless), displayed by safe human
// name/email/role - never a raw auth uid as the primary label.
export function AssigneePicker({ label, value, onChange, id }: { label: string; value: { userRef: string; displayName: string } | null; onChange: (next: { userRef: string; displayName: string } | null) => void; id: string }) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<AdminUserOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      void searchActiveUsers(query, { signal: controller.signal }).then((result) => {
        if (controller.signal.aborted) return;
        setOptions(result.ok ? result.data.users.filter((u) => u.active) : []);
        setLoading(false);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return (
    <div>
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <div className="inputwrap">
          <Icon name="search" />
          <input id={id} type="search" placeholder="Search by email…" value={query} onChange={(event) => setQuery(event.target.value)} data-testid="assignee-search-input" />
        </div>
      </div>

      <div className="tablewrap" style={{ marginTop: 8 }}>
        <table className="compact">
          <caption className="sr">Active user search results</caption>
          <tbody>
            {loading && (
              <tr>
                <td>Searching…</td>
              </tr>
            )}
            {!loading && options.length === 0 && (
              <tr>
                <td className="foundationnote">No active users found.</td>
              </tr>
            )}
            {!loading &&
              options.map((user) => {
                const displayName = user.displayName?.trim() || user.email;
                const active = value?.userRef === user.userRef;
                return (
                  <tr key={user.userRef} className={active ? "active" : undefined} data-testid="assignee-option-row">
                    <td>
                      <b>{displayName}</b>
                      <small style={{ display: "block" }}>{user.role}</small>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button type="button" className={active ? "btn primary" : "btn"} onClick={() => onChange(active ? null : { userRef: user.userRef, displayName })} data-testid="select-assignee">
                        {active ? "Selected" : "Select"}
                      </button>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      {value && (
        <p className="foundationnote" style={{ marginTop: 8 }} data-testid="selected-assignee-summary">
          Selected: {value.displayName}
        </p>
      )}
    </div>
  );
}
