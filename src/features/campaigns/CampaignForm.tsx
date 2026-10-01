"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Fields, Field, FormFoot } from "@/ui/Form";
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

  const [teams, setTeams] = useState("");
  const [owner, setOwner] = useState<CampaignOwnerCandidateDto | null>(null);

  const [reviewPolicy, setReviewPolicy] = useState<"REVIEW_REQUIRED" | "NO_PREPOST_REVIEW">("REVIEW_REQUIRED");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const nameRef = useRef<HTMLInputElement>(null);
  const objectiveRef = useRef<HTMLTextAreaElement>(null);
  const startDateRef = useRef<HTMLInputElement>(null);
  const endDateRef = useRef<HTMLInputElement>(null);

  // Finding #33: the disabled-submit-button pattern silently swallowed
  // missing-required-field feedback (a disabled button never triggers the
  // browser's native required-field message, and no other signal replaced
  // it). This performs the same checks explicitly, surfaces a per-field
  // inline error, and moves focus to the first invalid field - mirroring
  // (client-side, for immediate feedback) the date-ordering rule the
  // server already enforces in campaign-service.ts.
  function validate(): { errors: Record<string, string>; firstInvalid: React.RefObject<HTMLElement | null> | null } {
    const errors: Record<string, string> = {};
    let firstInvalid: React.RefObject<HTMLElement | null> | null = null;
    function fail(field: string, message: string, ref: React.RefObject<HTMLElement | null>) {
      errors[field] = message;
      if (!firstInvalid) firstInvalid = ref;
    }
    if (!name.trim()) fail("name", "Campaign name is required.", nameRef);
    if (!objective.trim()) fail("objective", "Objective / description is required.", objectiveRef);
    if (!startDate) fail("startDate", "Start date is required.", startDateRef);
    if (!endDate) fail("endDate", "End date is required.", endDateRef);
    if (startDate && endDate && endDate < startDate) fail("endDate", "End date cannot be before start date.", endDateRef);
    return { errors, firstInvalid };
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaveError(null);

    const { errors, firstInvalid } = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      firstInvalid?.current?.focus();
      return;
    }

    setSaving(true);

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
        // Finding #32 (user-decided): Categories removed from the create
        // form entirely - categoryIds stays a real, readable field on the
        // stored schema (campaignCriteriaSchema is .strict(), so the field
        // itself can never be deleted without breaking every already-
        // stored Campaign's parse) but new Campaigns simply never set it.
        //
        // Finding #34: criteria.platforms is likewise no longer asked for
        // separately here - the server itself mirrors it from the
        // canonical `platforms` field above (single source of truth,
        // enforced server-side, not just by omitting this UI field) -
        // nothing sent here for it is ever read.
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
    // Finding #35: the /foundation style guide's own documented rule for this page type
    // ("Detail / Create / Edit: forms capped at 1,080px. Group related information side by
    // side; do not stretch every section.") governs "use the full page width" here - it means
    // using the existing 1080px form cap more effectively via two-column grouping, not
    // stretching past it to the 1590px dashboard-canvas width. The static tips sidebar (which
    // sat beside the form, not stacked in it, so it was never itself the cause of the ~1600px
    // scroll) is now a compact top banner; the previous 5 vertically-stacked FormSections
    // become 2 side-by-side panels, reusing the exact .grid/.s7/.s5/.panel pattern the Finance
    // Agreement create wizard already established (TermsTargetsStep.tsx) - no second design
    // system, no new CSS.
    <div style={{ maxWidth: 1080, margin: "0 auto" }}>
      <div className="banner">
        <Icon name="check" />
        <span>
          <b>A cleaner first step.</b> No invented platform catalog · Target Audience, never Tier · Resources and lifecycle are captured from the detail page after creation · every Campaign starts in DRAFT.
        </span>
      </div>

      {/* Finding #33: noValidate hands control entirely to handleSubmit's own
          validate() - without it, the browser's native required-field
          tooltip intercepts the FIRST submit attempt before handleSubmit
          ever runs, so the custom error banner/per-field messages (and the
          date-ordering check, which native validation can't express at
          all) would only ever appear starting on the SECOND click. */}
      <form onSubmit={handleSubmit} noValidate>
        <div className="grid">
          <div className="s7">
            <section className="panel">
              <div className="panelhead">
                <h2>Campaign basics</h2>
                <p>Use a clear, recognizable name to keep reporting unambiguous.</p>
              </div>
              <div className="panelbody">
                <Fields>
                  <Field label="Campaign name" required error={fieldErrors.name}>
                    <input
                      ref={nameRef}
                      type="text"
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value);
                        if (fieldErrors.name) setFieldErrors((cur) => ({ ...cur, name: "" }));
                      }}
                      required
                      maxLength={200}
                      placeholder="Civic Voices"
                    />
                  </Field>
                  <Field label="Start date" required error={fieldErrors.startDate}>
                    <input
                      ref={startDateRef}
                      type="date"
                      value={startDate}
                      onChange={(e) => {
                        setStartDate(e.target.value);
                        if (fieldErrors.startDate) setFieldErrors((cur) => ({ ...cur, startDate: "" }));
                      }}
                      required
                    />
                  </Field>
                  <Field label="End date" required error={fieldErrors.endDate}>
                    <input
                      ref={endDateRef}
                      type="date"
                      value={endDate}
                      onChange={(e) => {
                        setEndDate(e.target.value);
                        if (fieldErrors.endDate) setFieldErrors((cur) => ({ ...cur, endDate: "" }));
                      }}
                      required
                    />
                  </Field>
                </Fields>
                <Field label="Objective / description" full required error={fieldErrors.objective}>
                  <textarea
                    ref={objectiveRef}
                    value={objective}
                    onChange={(e) => {
                      setObjective(e.target.value);
                      if (fieldErrors.objective) setFieldErrors((cur) => ({ ...cur, objective: "" }));
                    }}
                    required
                    maxLength={2000}
                    placeholder="What this programme is trying to achieve."
                  />
                </Field>
                {/* Finding #34: asked exactly once - the same canonical value the server now
                    also mirrors into criteria.platforms (single source of truth), never a
                    second "Targeting platforms" input. */}
                <Field label="Platforms" full hint="One or more normalized platform identifiers - the same identifiers Partner Accounts use. Never a fixed whitelist.">
                  <MultiSelectDropdown value={platforms} onChange={setPlatforms} groups={PLATFORM_GROUPS} placeholder="Select platforms…" allowCustom customPlaceholder="Other platform…" />
                </Field>
              </div>
            </section>
          </div>

          <div className="s5">
            <section className="panel">
              <div className="panelhead">
                <h2>Targeting</h2>
                <p>Business intent for who this programme is for - never authorization scope.</p>
              </div>
              <div className="panelbody">
                <Fields>
                  <Field label="Target Audience">
                    <TargetAudienceMultiSelect value={targetAudience} onChange={setTargetAudience} />
                  </Field>
                  <Field label="Languages">
                    <input type="text" value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="Malayalam, English" />
                  </Field>
                </Fields>
                <Field label="Regions" full>
                  <RegionMultiSelect value={regions} onChange={setRegions} />
                </Field>
                <p className="foundationnote">Target Audience is the audience-segmentation criterion. Partner tier is not part of Campaign targeting.</p>
              </div>
            </section>

            <section className="panel" style={{ marginTop: 18 }}>
              <div className="panelhead">
                <h2>Ownership</h2>
                <p>Owner is optional - an unassigned Campaign is flagged for attention, not blocked from being created.</p>
              </div>
              <div className="panelbody">
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
              </div>
            </section>
          </div>

          <div className="s12">
            <section className="panel">
              <div className="panelhead">
                <h2>Review policy</h2>
                <p>The default that later Assignments snapshot at creation time - changing it here never rewrites existing Assignment history.</p>
              </div>
              <div className="panelbody">
                <Field label="Default review policy">
                  <select value={reviewPolicy} onChange={(e) => setReviewPolicy(e.target.value as "REVIEW_REQUIRED" | "NO_PREPOST_REVIEW")}>
                    <option value="REVIEW_REQUIRED">{REVIEW_POLICY_LABELS.REVIEW_REQUIRED}</option>
                    <option value="NO_PREPOST_REVIEW">{REVIEW_POLICY_LABELS.NO_PREPOST_REVIEW}</option>
                  </select>
                </Field>
                <p className="foundationnote">
                  {reviewPolicy === "REVIEW_REQUIRED"
                    ? "Content submitted under this Campaign will require review before and after publishing, unless a future Assignment says otherwise."
                    : "Content submitted under this Campaign will not require pre/post review by default."}
                </p>
              </div>
            </section>
          </div>
        </div>

        <section className="panel" style={{ marginTop: 18 }}>
          {Object.values(fieldErrors).some(Boolean) && (
            <div className="banner" role="alert" style={{ margin: "18px 20px 0" }}>
              <b>Please fix the highlighted field(s) above before creating this Campaign.</b>
            </div>
          )}

          {saveError && (
            <div className="banner" role="alert" style={{ margin: "18px 20px 0" }}>
              <b>Couldn&rsquo;t save.</b> {saveError}
            </div>
          )}

          <FormFoot>
            <small>Creates a real Campaign in DRAFT status</small>
            <div className="actions">
              <Link href="/campaigns" className="btn">
                Cancel
              </Link>
              <button type="submit" className="btn primary" disabled={saving}>
                {saving ? "Saving…" : "Create campaign"}
              </button>
            </div>
          </FormFoot>
        </section>
      </form>
    </div>
  );
}
