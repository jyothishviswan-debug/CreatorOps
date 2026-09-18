import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { ContentDetail } from "@/features/content/ContentDetail";
import { getContent } from "@/server/content/content-service";
import { resolveRequestActor } from "@/server/content/http";
import { canPerformAction } from "@/server/authz/capabilities";

export default async function ContentDetailPage({ params }: { params: Promise<{ contentId: string }> }) {
  const { contentId } = await params;
  const actor = await resolveRequestActor();
  const result = await getContent(actor, contentId);

  if (!result.ok) {
    return (
      <AppShell>
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view this Content record." icon="lock" />
        </section>
      </AppShell>
    );
  }

  // Step 11B: the ONE fine-grained action-level UI gate in this build -
  // computed once, server-side, and threaded down as a plain boolean prop
  // (ContentDetail -> ContentNextActionPanel). Every other Content action
  // renders unconditionally and relies on the API's own 403, matching the
  // established Vendor/Partner precedent - this single exception exists
  // only because the task explicitly calls out hiding the Review
  // submission action from actors who cannot review.
  const actorCanReview = actor ? await canPerformAction(actor, "content", "review_content") : false;

  return (
    <AppShell>
      <ContentDetail initialContent={result.data} actorCanReview={actorCanReview} />
    </AppShell>
  );
}
