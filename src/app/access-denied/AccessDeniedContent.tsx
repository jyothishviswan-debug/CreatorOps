"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { Icon } from "@/ui/icons";
import { EmptyState } from "@/ui/States";
import { FEATURE_LABELS, isFeatureId } from "@/server/authz/features";

export function AccessDeniedContent() {
  const searchParams = useSearchParams();
  const featureParam = searchParams.get("feature");
  const featureLabel = isFeatureId(featureParam) ? FEATURE_LABELS[featureParam] : null;

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">ACCESS DENIED</div>
          <h1>You don&rsquo;t have access to this area</h1>
          <p>
            {featureLabel
              ? `Your role doesn't include access to ${featureLabel}.`
              : "Your role doesn't include access to this area."}
          </p>
        </div>
        <div className="actions">
          <Link href="/dashboard" className="btn primary">
            Back to Dashboard
          </Link>
        </div>
      </div>
      <section className="panel s12">
        <div className="panelbody">
          <EmptyState
            title="Restricted by role"
            description="If you believe you should have access, contact your administrator. Access is granted explicitly per role, not inferred from any other permission you may already have."
            icon="lock"
            action={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 11 }}>
                <Icon name="shield" />
                Authorized scope preview
              </span>
            }
          />
        </div>
      </section>
    </>
  );
}
