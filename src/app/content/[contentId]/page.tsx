import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { DetailView } from "@/ui/DetailView";
import { getContentDetail } from "@/features/content/fixtures";

export default async function ContentDetailPage({
  params,
}: {
  params: Promise<{ contentId: string }>;
}) {
  const { contentId } = await params;
  const detail = getContentDetail(contentId);
  if (!detail) notFound();

  return (
    <AppShell>
      <DetailView moduleLabel="Content" workspaceHref="/content" detail={detail} />
    </AppShell>
  );
}
