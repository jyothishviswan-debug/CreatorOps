"use client";

import { useEffect, useState } from "react";

import type { ManagerCandidateDto } from "@/server/discovery/user-picker";
import { searchManagerCandidates } from "./api-client";
import { SearchInput } from "@/ui/Table";

// "Manager picker must use real active admitted users; never a
// free-text/checkbox substitute" (Step 6B) - search-first over the real
// bounded /api/discovery/users/search endpoint, same idiom as
// Administration's user search.
export function ManagerPicker({ onSelect, placeholder = "Search by email…" }: { onSelect: (candidate: ManagerCandidateDto) => void; placeholder?: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ManagerCandidateDto[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = query.trim();
  const displayResults = trimmed.length < 2 ? [] : results;

  useEffect(() => {
    if (trimmed.length < 2) return;
    let cancelled = false;
    const timeout = setTimeout(async () => {
      setSearching(true);
      const result = await searchManagerCandidates(trimmed.toLowerCase());
      if (cancelled) return;
      setSearching(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setResults(result.data);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [trimmed]);

  return (
    <div>
      <SearchInput aria-label="Search active users by email" placeholder={placeholder} value={query} onChange={(e) => setQuery(e.target.value)} />
      {searching && <small>Searching…</small>}
      {error && (
        <div className="banner" role="alert" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
      {displayResults.length > 0 && (
        <div className="searchresults">
          {displayResults.map((candidate) => (
            <button
              key={candidate.userRef}
              type="button"
              onClick={() => {
                onSelect(candidate);
                setQuery("");
                setResults([]);
              }}
            >
              <b>{candidate.displayName}</b>
              <br />
              <small>{candidate.email}</small>
            </button>
          ))}
        </div>
      )}
      {trimmed.length >= 2 && !searching && displayResults.length === 0 && !error && <small>No active users match &ldquo;{trimmed}&rdquo;.</small>}
    </div>
  );
}
