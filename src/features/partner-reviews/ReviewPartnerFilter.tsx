"use client";

// Step 13B: the Workspace's Partner filter - a bounded, scope-first Partner search (display-name prefix,
// server-side; an out-of-scope Partner can never appear) that only ever changes the URL. Built from the
// accepted pieces of the Analytics Partner selector: the shared `SearchInput` (`inputwrap`) as an ARIA
// combobox + the `.searchresults` listbox. Keyboard: type to search (debounced, stale requests aborted);
// ArrowDown / ArrowUp move through results (focus stays in the input via aria-activedescendant); Enter
// picks the highlighted Partner; Escape closes the list with focus still in the input.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { SearchInput } from "@/ui/Table";

import { searchReviewPartnersApi } from "./api-client";

const SEARCH_DEBOUNCE_MS = 250;

type Result = { partnerRef: string; displayName: string; regions: string[] };

export function ReviewPartnerFilter({ selected, onSelect }: { selected: { partnerRef: string; displayName: string } | null; onSelect: (partnerRef: string | null) => void }) {
  const listId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [active, setActive] = useState(-1);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setStatus("loading");
      const result = await searchReviewPartnersApi({ q: query.trim(), signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setResults([]);
        setHasMore(false);
        setStatus("error");
        return;
      }
      setResults(result.data.partners);
      setHasMore(result.data.hasMore);
      setActive(-1);
      setStatus("ready");
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    function onOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  function choose(partner: Result) {
    setOpen(false);
    setQuery("");
    setActive(-1);
    onSelect(partner.partnerRef);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      else setActive((index) => Math.min(index + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      if (open && active >= 0 && results[active]) {
        event.preventDefault();
        choose(results[active]);
      }
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        setActive(-1);
      }
    }
  }

  const optionId = (index: number) => `${listId}-option-${index}`;
  const statusText =
    status === "loading"
      ? "Searching…"
      : status === "error"
        ? "Couldn’t search Partners. Try again."
        : status === "ready" && results.length === 0
          ? "No matching Partners in your authorized scope"
          : status === "ready" && hasMore
            ? `Showing the first ${results.length} matches — keep typing to narrow`
            : status === "ready"
              ? `${results.length} Partner${results.length === 1 ? "" : "s"} found`
              : "";

  return (
    <div ref={containerRef} style={{ position: "relative", minWidth: 200, flex: "1 1 220px" }}>
      <SearchInput
        placeholder={selected ? `Partner: ${selected.displayName}` : "Search Partners by name…"}
        aria-label="Search Partners by name"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div style={{ position: "absolute", zIndex: 5, left: 0, right: 0, background: "white", border: "1px solid var(--line)", borderRadius: 8, padding: 6, marginTop: 4 }}>
          <div id={listId} role="listbox" aria-label="Partner search results" className="searchresults" style={{ marginTop: 0, maxHeight: 240 }}>
            {results.map((partner, index) => (
              <button
                key={partner.partnerRef}
                id={optionId(index)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={selected?.partnerRef === partner.partnerRef}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(partner)}
                style={{ display: "block", width: "100%", background: index === active ? "var(--tint)" : undefined }}
              >
                <b style={{ display: "block" }}>{partner.displayName}</b>
                <small className="muted">{partner.regions.length > 0 ? partner.regions.join(", ") : "No region recorded"}</small>
              </button>
            ))}
          </div>
          <p className="foundationnote" role="status" style={{ margin: "6px 0 0" }}>
            {statusText}
          </p>
        </div>
      )}
    </div>
  );
}
