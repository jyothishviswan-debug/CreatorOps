import { PlatformAnalyticsPage } from "@/features/analytics/PlatformAnalyticsPage";

// Step 12D: thin wrapper - the whole view is the one shared, platform-
// parameterized PlatformAnalyticsPage.
export default function YouTubeAnalyticsPage() {
  return <PlatformAnalyticsPage platform="youtube" />;
}
