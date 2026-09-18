// Thin fetch wrapper around the one genuinely unauthenticated route in
// this app (/api/public/submissions/[token], Step 10A) - no session, no
// cookie, no Content-Type-only header beyond JSON. The bearer token lives
// only in the URL path here, never in any other client-side storage.
export type SubmitRowsResult = { ok: true; submissionRef: string } | { ok: false; code: "invalid" | "unusable" | "network_error"; error: string };

export async function submitPublicLinks(token: string, rows: { platform: string; url: string }[]): Promise<SubmitRowsResult> {
  let res: Response;
  try {
    res = await fetch(`/api/public/submissions/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });
  } catch {
    return { ok: false, code: "network_error", error: "Could not reach the server. Check your connection and try again." };
  }

  if (res.ok) {
    const data = (await res.json()) as { submissionRef: string };
    return { ok: true, submissionRef: data.submissionRef };
  }

  let error = "This submission link is no longer valid.";
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === "string") error = body.error;
  } catch {
    // No JSON body - keep the generic message.
  }

  return { ok: false, code: res.status === 400 ? "invalid" : "unusable", error };
}
