"use client";

import { useEffect, useState } from "react";

import type { CampaignOwnerCandidateDto } from "@/server/campaigns/user-picker";
import { searchCampaignOwnerCandidates } from "./api-client";
import { SearchInput } from "@/ui/Table";

// "Owner picker must use real active admitted users; never a free-text
// substitute" - search-first over the real bounded
// /api/campaigns/users/search endpoint, same idiom as Vendors'/Partners'
// own owner pickers.
export function CampaignOwnerPicker({ onSelect, placeholder = "Search by email…" }: { onSelect: (candidate: CampaignOwnerCandidateDto) => void; placeholder?: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CampaignOwnerCandidateDto[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = query.trim();
  const displayResults = trimmed.length < 2 ? [] : results;

  useEffect(() => {
    if (trimmed.length < 2) return;
    let cancelled = false;
    const timeout = setTimeout(async () => {
      setSearching(true);
      const result = await searchCampaignOwnerCandidates(trimmed.toLowerCase());
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
