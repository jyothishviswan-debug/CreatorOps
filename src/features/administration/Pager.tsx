"use client";

// Numbered page controls over a cursor-bounded API: page numbers are only
// ever rendered for pages already fetched (cursor pagination has no
// "jump to page 9" without visiting 1-8 first) plus one more once another
// page is known to exist - never a fabricated total page count.
export function Pager({
  currentPage,
  knownPages,
  hasMore,
  busy,
  onChange,
}: {
  currentPage: number;
  knownPages: number;
  hasMore: boolean;
  busy?: boolean;
  onChange: (page: number) => void;
}) {
  if (knownPages <= 1 && !hasMore) return null;

  return (
    <nav className="segment" aria-label="Pagination">
      <button type="button" disabled={busy || currentPage <= 1} onClick={() => onChange(currentPage - 1)}>
        Prev
      </button>
      {Array.from({ length: knownPages }, (_, i) => i + 1).map((page) => (
        <button key={page} type="button" className={page === currentPage ? "active" : ""} disabled={busy} aria-current={page === currentPage ? "page" : undefined} onClick={() => onChange(page)}>
          {page}
        </button>
      ))}
      <button type="button" disabled={busy || (!hasMore && currentPage >= knownPages)} onClick={() => onChange(currentPage + 1)}>
        Next
      </button>
    </nav>
  );
}
