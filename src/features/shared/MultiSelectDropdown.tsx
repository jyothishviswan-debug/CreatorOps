"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/ui/icons";

export type MultiSelectGroup = { label: string; options: string[] };

// A real multi-selection dropdown: a closed control that shows the
// current selection, opens a panel (optionally with a search box and
// grouped checkboxes) on click, and closes on an outside click - never a
// native unstyled <datalist> popup, never a native <select multiple>
// listbox (which never closes and needs ctrl/cmd-click). An optional
// free-text "other" row keeps the field genuinely open-ended when
// `allowCustom` is set, so a caller-supplied group list is never a fixed
// whitelist. Shared base for CampaignForm's PlatformMultiSelect and
// RegionMultiSelect.
export function MultiSelectDropdown({
  value,
  onChange,
  groups,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  allowCustom = false,
  customPlaceholder = "Other…",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  groups: MultiSelectGroup[];
  placeholder?: string;
  searchPlaceholder?: string;
  allowCustom?: boolean;
  customPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [customInput, setCustomInput] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutsideClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [open]);

  const selectedLower = new Set(value.map((v) => v.toLowerCase()));
  const allKnown = new Set(groups.flatMap((g) => g.options).map((o) => o.toLowerCase()));
  const extraSelected = value.filter((v) => !allKnown.has(v.toLowerCase()));
  const query = search.trim().toLowerCase();
  const visibleGroups = query
    ? groups.map((g) => ({ ...g, options: g.options.filter((o) => o.toLowerCase().includes(query)) })).filter((g) => g.options.length > 0)
    : groups;

  function toggle(name: string) {
    const already = selectedLower.has(name.toLowerCase());
    onChange(already ? value.filter((v) => v.toLowerCase() !== name.toLowerCase()) : [...value, name]);
  }

  // Selecting the group heading itself toggles every option in that
  // group at once - if all are already selected, it clears just that
  // group; otherwise it adds whichever of the group's options aren't
  // selected yet, leaving selections from other groups untouched.
  function toggleGroup(group: MultiSelectGroup) {
    const groupLower = group.options.map((o) => o.toLowerCase());
    const allSelected = groupLower.every((o) => selectedLower.has(o));
    if (allSelected) {
      onChange(value.filter((v) => !groupLower.includes(v.toLowerCase())));
    } else {
      const toAdd = group.options.filter((o) => !selectedLower.has(o.toLowerCase()));
      onChange([...value, ...toAdd]);
    }
  }

  function addCustom() {
    const trimmed = customInput.trim();
    if (!trimmed || selectedLower.has(trimmed.toLowerCase())) return;
    onChange([...value, trimmed]);
    setCustomInput("");
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          textAlign: "left",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          border: "1px solid #dce1e7",
          borderRadius: 6,
          padding: "8px 10px",
          background: "white",
          color: "var(--ink)",
          fontSize: 12,
        }}
      >
        <span>{value.length > 0 ? value.join(", ") : placeholder}</span>
        <Icon name="chevronDown" className="muted" style={{ width: 14, height: 14, flexShrink: 0 }} />
      </button>
      {open && (
        <div className="panel" role="listbox" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 20, padding: 10, maxHeight: 320, overflow: "auto" }}>
          {groups.length > 1 || groups[0]?.options.length > 8 ? (
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={searchPlaceholder} style={{ width: "100%", marginBottom: 8 }} />
          ) : null}
          {visibleGroups.length === 0 && <p className="foundationnote">No matches.</p>}
          {visibleGroups.map((group) => {
            const groupLower = group.options.map((o) => o.toLowerCase());
            const selectedInGroup = groupLower.filter((o) => selectedLower.has(o)).length;
            return (
            <div key={group.label} style={{ marginBottom: 8 }}>
              {groups.length > 1 && (
                <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 4px 2px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={selectedInGroup === groupLower.length}
                    ref={(el) => {
                      if (el) el.indeterminate = selectedInGroup > 0 && selectedInGroup < groupLower.length;
                    }}
                    onChange={() => toggleGroup(group)}
                  />
                  <span style={{ fontSize: 10, fontWeight: 650, color: "var(--muted)", letterSpacing: ".5px" }}>{group.label.toUpperCase()}</span>
                </label>
              )}
              {group.options.map((option) => (
                <label key={option} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 4px", cursor: "pointer" }}>
                  <input type="checkbox" checked={selectedLower.has(option.toLowerCase())} onChange={() => toggle(option)} />
                  {option}
                </label>
              ))}
            </div>
            );
          })}
          {extraSelected.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {groups.length > 1 && <div style={{ fontSize: 10, fontWeight: 650, color: "var(--muted)", letterSpacing: ".5px", padding: "4px 4px 2px" }}>OTHER</div>}
              {extraSelected.map((option) => (
                <label key={option} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 4px", cursor: "pointer" }}>
                  <input type="checkbox" checked readOnly onChange={() => toggle(option)} />
                  {option}
                </label>
              ))}
            </div>
          )}
          {allowCustom && (
            <div className="actions" style={{ marginTop: 4 }}>
              <input
                type="text"
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
                placeholder={customPlaceholder}
                style={{ flex: 1 }}
              />
              <button type="button" className="btn" onClick={addCustom}>
                Add
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
