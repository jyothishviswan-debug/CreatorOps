"use client";

import { useEffect, useState } from "react";

import { SearchInput } from "@/ui/Table";
import type { PartnerDto } from "@/server/partners/client-dto";
import { listPartners } from "@/features/partners/api-client";

// Step 8B section 6: the Partner picker used when linking a Vendor to a
// Partner. Deliberately reuses the EXISTING, already scope-certified
// `/api/partners` list endpoint (via Partners' own api-client) rather
// than inventing a new "search partners" surface - this is what makes
// the picker scope-safe by construction: an actor can only ever see the
// same Partners the real Partners Workspace would show them, never a
// global directory. Never leaks cross-scope Partner existence - a
// search that matches nothing out-of-scope simply returns no results,
// identical to a search that matches nothing at all.
export function VendorPartnerPicker({ onSelect, placeholder = "Search partners by name…" }: { onSelect: (partner: PartnerDto) => void; placeholder?: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PartnerDto[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = query.trim();
  const displayResults = trimmed.length < 2 ? [] : results;

  useEffect(() => {
    if (trimmed.length < 2) return;
    let cancelled = false;
    const timeout = setTimeout(async () => {
      setSearching(true);
      const result = await listPartners({ displayNamePrefix: trimmed.toLowerCase(), limit: 8 });
      if (cancelled) return;
      setSearching(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setResults(result.data.partners);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [trimmed]);

  return (
    <div>
      <SearchInput aria-label="Search Partners by name" placeholder={placeholder} value={query} onChange={(e) => setQuery(e.target.value)} />
      {searching && <small>Searching…</small>}
      {error && (
        <div className="banner" role="alert" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
      {displayResults.length > 0 && (
        <div className="searchresults">
          {displayResults.map((partner) => (
            <button
              key={partner.partnerRef}
              type="button"
              onClick={() => {
                onSelect(partner);
                setQuery("");
                setResults([]);
              }}
            >
              <b>{partner.displayName}</b>
              <br />
              <small>{partner.regionIds[0] ?? "No region on file"}</small>
            </button>
          ))}
        </div>
      )}
      {trimmed.length >= 2 && !searching && displayResults.length === 0 && !error && <small>No Partners you&rsquo;re authorized to see match &ldquo;{trimmed}&rdquo;.</small>}
    </div>
  );
}
