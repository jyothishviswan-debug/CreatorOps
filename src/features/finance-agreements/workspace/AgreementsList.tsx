"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import { Pager } from "@/features/administration/Pager";
import { EmptyState, Skeleton } from "@/ui/States";
import type { AgreementWorkspaceDto, AgreementWorkspaceRowDto } from "@/server/finance-agreements/workspace-dto";

import { loadAgreementsWorkspace } from "../api-client";
import { AgreementCards, AgreementsTable } from "./AgreementRows";
import { PAGE_ERROR_TITLE, pageStatusCopy, workspaceEmptyCopy } from "./workspace-copy";
import { toWorkspaceRequest, type WorkspaceUrlState } from "./workspace-query";
import { NEW_AGREEMENT_HREF, toWorkspaceRowView } from "./workspace-view-model";
import type { WorkspaceLayout } from "./WorkspaceToolbar";

// Step 14B: one filter state's list of Agreement rows. It is REMOUNTED (React `key` = the canonical URL state) whenever a filter
// changes, so its page cache can never leak across filters. Page 1 is the server-rendered `initial`; every further page is ONE
// bounded cursor request (the opaque cursor comes only from the previous response) - nothing is fetched whole, nothing is
// filtered or sorted in the browser (the server's order is deterministic and is kept as received).
export function AgreementsList({ initial, state, layout, anyFilterActive, onClearFilters }: { initial: AgreementWorkspaceDto; state: WorkspaceUrlState; layout: WorkspaceLayout; anyFilterActive: boolean; onClearFilters: () => void }) {
  const [pages, setPages] = useState<AgreementWorkspaceRowDto[][]>([initial.rows]);
  const [nextCursors, setNextCursors] = useState<(string | null)[]>([initial.nextCursor]);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Leaving (a filter change remounts this list) cancels an in-flight page request.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function goToPage(page: number) {
    if (page < 1 || page === currentPage || busyRef.current) return;
    if (page <= pages.length) {
      setError(null);
      setCurrentPage(page);
      return;
    }
    const cursor = nextCursors[page - 2];
    if (page > pages.length + 1 || !cursor) return;

    busyRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    const result = await loadAgreementsWorkspace(toWorkspaceRequest(state, { cursor }), { signal: controller.signal });
    if (result.ok === false && result.aborted) return;
    busyRef.current = false;
    setLoading(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPages((previous) => [...previous, result.data.rows]);
    setNextCursors((previous) => [...previous, result.data.nextCursor]);
    setCurrentPage(page);
  }

  const pageRows = pages[currentPage - 1] ?? [];
  const views = pageRows.map(toWorkspaceRowView);
  const hasMore = nextCursors[currentPage - 1] != null;
  const { disclosure, permissions } = initial;
  const emptyCopy = workspaceEmptyCopy({ headsRead: disclosure.headsRead, headsTruncated: disclosure.headsTruncated, anyFilterActive, canManage: permissions.canManage });
  const noAgreementsAtAll = !anyFilterActive && !disclosure.headsTruncated;

  return (
    <>
      {error && (
        <div className="banner" role="alert" style={{ margin: "0 18px 15px" }}>
          <b>{PAGE_ERROR_TITLE}</b> {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "0 18px 18px" }} aria-hidden="true" data-testid="workspace-loading">
          <Skeleton lines={5} />
        </div>
      ) : views.length === 0 ? (
        <EmptyState
          title={emptyCopy.title}
          description={emptyCopy.description}
          icon={anyFilterActive ? "search" : "file"}
          action={
            anyFilterActive ? (
              <button className="btn" type="button" onClick={onClearFilters}>
                Clear filters
              </button>
            ) : noAgreementsAtAll && permissions.canManage ? (
              <Link className="btn primary" href={NEW_AGREEMENT_HREF}>
                New Agreement
              </Link>
            ) : undefined
          }
        />
      ) : layout === "cards" ? (
        <AgreementCards rows={views} />
      ) : (
        <AgreementsTable rows={views} />
      )}

      <div className="panelfoot" style={{ flexWrap: "wrap", alignItems: "center" }}>
        <span data-testid="workspace-page-status">{pageStatusCopy(currentPage, pageRows.length)}</span>
        <Pager currentPage={currentPage} knownPages={pages.length} hasMore={hasMore} busy={loading} onChange={goToPage} />
      </div>
    </>
  );
}
