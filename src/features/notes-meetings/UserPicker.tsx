"use client";

import { useEffect, useState, type ReactElement } from "react";

import { Icon } from "@/ui/icons";

import { searchActiveUsers, type NmUserOption } from "./api-client";

const SEARCH_DEBOUNCE_MS = 300;

export type PickedUser = { userRef: string; displayName: string };

type SingleProps = { label: string; id: string; multi?: false; value: PickedUser | null; onChange: (next: PickedUser | null) => void };
type MultiProps = { label: string; id: string; multi: true; value: PickedUser[]; onChange: (next: PickedUser[]) => void };

// Notes/Meetings Completion: the reusable participant/assignee picker - mirrors
// src/features/operations/AssigneePicker.tsx's own search/debounce/render shape exactly, extended
// with an optional multi-select mode for Meeting participants. Active/admitted CreatorOps users only
// (the server re-checks this regardless on every write). Two overload signatures give each call site
// full type safety (single vs. multi select never mixed up); the implementation below narrows `multi`
// once at runtime instead of fighting the discriminated union through destructuring.
export function UserPicker(props: SingleProps): ReactElement;
export function UserPicker(props: MultiProps): ReactElement;
export function UserPicker(props: SingleProps | MultiProps) {
  const { label, id } = props;
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<NmUserOption[]>([]);
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

  const selectedList: PickedUser[] = props.multi ? props.value : props.value ? [props.value] : [];
  const selectedRefs = new Set(selectedList.map((v) => v.userRef));

  function toggle(user: NmUserOption) {
    const displayName = user.displayName?.trim() || user.email;
    if (props.multi) {
      if (selectedRefs.has(user.userRef)) props.onChange(props.value.filter((v) => v.userRef !== user.userRef));
      else props.onChange([...props.value, { userRef: user.userRef, displayName }]);
    } else {
      props.onChange(selectedRefs.has(user.userRef) ? null : { userRef: user.userRef, displayName });
    }
  }

  return (
    <div>
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <div className="inputwrap">
          <Icon name="search" />
          <input id={id} type="search" placeholder="Search by email…" value={query} onChange={(event) => setQuery(event.target.value)} />
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
                const active = selectedRefs.has(user.userRef);
                return (
                  <tr key={user.userRef} className={active ? "active" : undefined}>
                    <td>
                      <b>{displayName}</b>
                      <small style={{ display: "block" }}>{user.role}</small>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button type="button" className={active ? "btn primary" : "btn"} onClick={() => toggle(user)}>
                        {active ? (props.multi ? "Remove" : "Selected") : "Select"}
                      </button>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      {selectedList.length > 0 && (
        <p className="foundationnote" style={{ marginTop: 8 }}>
          Selected: {selectedList.map((v) => v.displayName).join(", ")}
        </p>
      )}
    </div>
  );
}
