"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { FormLayout, FormSection, Fields, Field, FormFoot, Checklist } from "@/ui/Form";
import { Icon } from "@/ui/icons";
import { MultiSelectDropdown } from "@/features/shared/MultiSelectDropdown";
import { RegionMultiSelect } from "@/features/shared/RegionMultiSelect";
import { TargetAudienceMultiSelect } from "@/features/shared/TargetAudienceMultiSelect";
import type { TargetAudience } from "@/server/campaigns/types";
import type { CampaignOwnerCandidateDto } from "@/server/campaigns/user-picker";
import { createCampaign } from "./api-client";
import { CampaignOwnerPicker } from "./CampaignOwnerPicker";
import { REVIEW_POLICY_LABELS } from "./format";

// A small set of convenience suggestions only - never a validated
// catalog (Step 9A.1/9B: Campaign platforms are free, normalized
// identifiers, compatible with Partner Account's own platform values,
// never a closed enum). The server normalizes and de-duplicates
// regardless of what's typed here.
const PLATFORM_GROUPS = [{ label: "Platforms", options: ["Instagram", "YouTube"] }];

function fromCsv(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

// Step 9B section 4: direct Campaign creation over the real trusted
// service. Grouped sections (basics / platforms / targeting / ownership
// / review policy / resources) rather than one long undifferentiated
// form. Resources are captured after creation (from the Detail page's
// own Resources tab), same "essentials first" idiom as Vendors'/
// Partners' own create forms.
export function CampaignForm() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const [platforms, setPlatforms] = useState<string[]>([]);

  const [targetAudience, setTargetAudience] = useState<TargetAudience[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [languages, setLanguages] = useState("");
  const [categories, setCategories] = useState("");
  const [criteriaPlatforms, setCriteriaPlatforms] = useState<string[]>([]);

  const [teams, setTeams] = useState("");
  const [owner, setOwner] = useState<CampaignOwnerCandidateDto | null>(null);

  const [reviewPolicy, setReviewPolicy] = useState<"REVIEW_REQUIRED" | "NO_PREPOST_REVIEW">("REVIEW_REQUIRED");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);

    const result = await createCampaign({
      name,
      objective,
      startDate,
      endDate,
      platforms,
      regionIds: regions,
      teamIds: fromCsv(teams),
      ownerUserRef: owner?.userRef,
      defaultReviewPolicy: reviewPolicy,
      criteria: {
        targetAudience,
        regionIds: regions,
        languageIds: fromCsv(languages),
        categoryIds: fromCsv(categories),
        platforms: criteriaPlatforms,
      },
    });
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.error);
      return;
    }
    router.push(`/campaigns/${result.data.campaignRef}`);
    router.refresh();
  }

  return (
    <FormLayout>
      <form className="panel" onSubmit={handleSubmit}>
        <FormSection title="Campaign basics" description="Use a clear, recognizable name to keep reporting unambiguous.">
          <Fields>
            <Field label="Campaign name">
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} placeholder="Civic Voices" />
            </Field>
            <Field label="Start date">
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
            </Field>
            <Field label="End date">
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
            </Field>
          </Fields>
          <Field label="Objective / description" full>
            <textarea value={objective} onChange={(e) => setObjective(e.target.value)} required maxLength={2000} placeholder="What this programme is trying to achieve." />
          </Field>
        </FormSection>

        <FormSection title="Platforms" description="One or more normalized platform identifiers - the same identifiers Partner Accounts use. Never a fixed whitelist.">
          <Field label="Platforms" full>
            <MultiSelectDropdown value={platforms} onChange={setPlatforms} groups={PLATFORM_GROUPS} placeholder="Select platforms…" allowCustom customPlaceholder="Other platform…" />
          </Field>
        </FormSection>

        <FormSection title="Targeting" description="Business intent for who this programme is for - never authorization scope.">
          <Fields>
            <Field label="Target Audience">
              <TargetAudienceMultiSelect value={targetAudience} onChange={setTargetAudience} />
            </Field>
            <Field label="Regions" full>
              <RegionMultiSelect value={regions} onChange={setRegions} />
            </Field>
            <Field label="Languages">
              <input type="text" value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="Malayalam, English" />
            </Field>
            <Field label="Categories">
              <input type="text" value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="Lifestyle, Education" />
            </Field>
            <Field label="Targeting platforms" full hint="Partners active on these platforms - can differ from where the Campaign itself publishes.">
              <MultiSelectDropdown value={criteriaPlatforms} onChange={setCriteriaPlatforms} groups={PLATFORM_GROUPS} placeholder="Select platforms…" allowCustom customPlaceholder="Other platform…" />
            </Field>
          </Fields>
          <p className="foundationnote">Target Audience is the audience-segmentation criterion. Partner tier is not part of Campaign targeting.</p>
        </FormSection>

        <FormSection title="Ownership" description="Owner is optional - an unassigned Campaign is flagged for attention, not blocked from being created.">
          <Fields>
            <Field label="Owner" full>
              {owner ? (
                <div className="banner" role="status">
                  <b>{owner.displayName}</b> · {owner.email}
                  <button type="button" className="btn" style={{ marginLeft: 10 }} onClick={() => setOwner(null)}>
                    Clear
                  </button>
                </div>
              ) : (
                <CampaignOwnerPicker onSelect={setOwner} />
              )}
            </Field>
            <Field label="Teams">
              <input type="text" value={teams} onChange={(e) => setTeams(e.target.value)} placeholder="kerala-programmes" />
            </Field>
          </Fields>
        </FormSection>

        <FormSection title="Review policy" description="The default that later Assignments snapshot at creation time - changing it here never rewrites existing Assignment history.">
          <Fields>
            <Field label="Default review policy">
              <select value={reviewPolicy} onChange={(e) => setReviewPolicy(e.target.value as "REVIEW_REQUIRED" | "NO_PREPOST_REVIEW")}>
                <option value="REVIEW_REQUIRED">{REVIEW_POLICY_LABELS.REVIEW_REQUIRED}</option>
                <option value="NO_PREPOST_REVIEW">{REVIEW_POLICY_LABELS.NO_PREPOST_REVIEW}</option>
              </select>
            </Field>
          </Fields>
          <p className="foundationnote">
            {reviewPolicy === "REVIEW_REQUIRED"
              ? "Content submitted under this Campaign will require review before and after publishing, unless a future Assignment says otherwise."
              : "Content submitted under this Campaign will not require pre/post review by default."}
          </p>
        </FormSection>

        {saveError && (
          <div className="banner" role="alert" style={{ margin: "0 22px 18px" }}>
            <b>Couldn&rsquo;t save.</b> {saveError}
          </div>
        )}

        <FormFoot>
          <small>Creates a real Campaign in DRAFT status</small>
          <div className="actions">
            <Link href="/campaigns" className="btn">
              Cancel
            </Link>
            <button type="submit" className="btn primary" disabled={saving || !name.trim() || !objective.trim() || !startDate || !endDate}>
              {saving ? "Saving…" : "Create campaign"}
            </button>
          </div>
        </FormFoot>
      </form>

      <aside className="panel">
        <div className="panelhead">
          <h2>A cleaner first step</h2>
        </div>
        <div className="panelbody">
          <Checklist>
            <li>
              <Icon name="check" /> Capture programme identity
            </li>
            <li>
              <Icon name="check" /> No invented platform catalog
            </li>
            <li>
              <Icon name="check" /> Target Audience, never Tier
            </li>
            <li>
              <Icon name="check" /> Resources and lifecycle captured from the detail page
            </li>
          </Checklist>
          <div className="scopebox">Every Campaign starts in DRAFT. Move it to Planned once readiness passes.</div>
        </div>
      </aside>
    </FormLayout>
  );
}
