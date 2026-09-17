"use client";

import { useState, type FormEvent } from "react";

import { Field, Fields } from "@/ui/Form";
import type { CampaignDto } from "@/server/campaigns/client-dto";
import { TARGET_AUDIENCES, type TargetAudience } from "@/server/campaigns/types";
import { editCampaign } from "./api-client";
import { REVIEW_POLICY_LABELS } from "./format";

function toCsv(values: string[]): string {
  return values.join(", ");
}
function fromCsv(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

const PLATFORM_SUGGESTIONS = ["Instagram", "YouTube", "Facebook", "X", "TikTok", "LinkedIn", "Snapchat", "Pinterest"];

// Ordinary plan editing, wired to the trusted versioned PATCH - the
// brief/plan fields and targeting criteria combined into one coherent
// area (Step 9B section 5), never lifecycle, never owner/team (its own
// authorized route/panel - see CampaignOwnerTeamPanel), never a resource
// mutation (its own endpoint). Campaign's own error shape has no
// "conflict" code (unlike Vendors'/Partners' own restricted-identity
// GST collision) - a bare 409 here is always stale_write.
export function CampaignPlanEditPanel({ campaign, onSaved }: { campaign: CampaignDto; onSaved: (campaign: CampaignDto) => void }) {
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState(campaign.objective);
  const [startDate, setStartDate] = useState(campaign.startDate);
  const [endDate, setEndDate] = useState(campaign.endDate);
  const [platforms, setPlatforms] = useState(toCsv(campaign.platforms));
  const [targetAudience, setTargetAudience] = useState<TargetAudience | "">(campaign.criteria.targetAudience ?? "");
  const [regions, setRegions] = useState(toCsv(campaign.regionIds));
  const [languages, setLanguages] = useState(toCsv(campaign.criteria.languageIds));
  const [categories, setCategories] = useState(toCsv(campaign.criteria.categoryIds));
  const [criteriaPlatforms, setCriteriaPlatforms] = useState(toCsv(campaign.criteria.platforms));
  const [reviewPolicy, setReviewPolicy] = useState(campaign.defaultReviewPolicy);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setStale(false);
    const regionIds = fromCsv(regions);
    const result = await editCampaign(campaign.campaignRef, {
      objective,
      startDate,
      endDate,
      platforms: fromCsv(platforms),
      regionIds,
      defaultReviewPolicy: reviewPolicy,
      criteria: {
        targetAudience: targetAudience || null,
        regionIds,
        languageIds: fromCsv(languages),
        categoryIds: fromCsv(categories),
        platforms: fromCsv(criteriaPlatforms),
      },
      expectedVersion: campaign.version,
    });
    setSaving(false);
    if (!result.ok) {
      if (result.code === "stale_write") {
        setStale(true);
        return;
      }
      setError(result.error);
      return;
    }
    setEditing(false);
    onSaved(result.data);
  }

  if (!editing) {
    return (
      <button type="button" className="btn" onClick={() => setEditing(true)}>
        Edit plan
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="record" style={{ marginTop: 12 }}>
      {stale && (
        <div className="banner" role="alert" style={{ marginBottom: 14 }}>
          <b>This Campaign was changed elsewhere.</b> Reload before saving again.
          <button className="btn" type="button" onClick={() => window.location.reload()} style={{ marginLeft: 10 }}>
            Reload
          </button>
        </div>
      )}
      <Fields>
        <Field label="Start date">
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
        </Field>
        <Field label="End date">
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
        </Field>
        <Field label="Platforms" hint="Comma-separated, normalized identifiers.">
          <input type="text" list="campaign-platform-suggestions" value={platforms} onChange={(e) => setPlatforms(e.target.value)} />
        </Field>
        <Field label="Target Audience">
          <select value={targetAudience} onChange={(e) => setTargetAudience(e.target.value as TargetAudience | "")}>
            <option value="">Not set</option>
            {TARGET_AUDIENCES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Regions">
          <input type="text" value={regions} onChange={(e) => setRegions(e.target.value)} placeholder="Kerala, Karnataka" />
        </Field>
        <Field label="Languages">
          <input type="text" value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="Malayalam, English" />
        </Field>
        <Field label="Categories">
          <input type="text" value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="Lifestyle, Education" />
        </Field>
        <Field label="Targeting platforms">
          <input type="text" list="campaign-platform-suggestions" value={criteriaPlatforms} onChange={(e) => setCriteriaPlatforms(e.target.value)} />
        </Field>
        <Field label="Default review policy">
          <select value={reviewPolicy} onChange={(e) => setReviewPolicy(e.target.value as CampaignDto["defaultReviewPolicy"])}>
            <option value="REVIEW_REQUIRED">{REVIEW_POLICY_LABELS.REVIEW_REQUIRED}</option>
            <option value="NO_PREPOST_REVIEW">{REVIEW_POLICY_LABELS.NO_PREPOST_REVIEW}</option>
          </select>
        </Field>
      </Fields>
      <datalist id="campaign-platform-suggestions">
        {PLATFORM_SUGGESTIONS.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <Field label="Objective / description" full>
        <textarea value={objective} onChange={(e) => setObjective(e.target.value)} required maxLength={2000} />
      </Field>
      <p className="foundationnote">Target Audience is the audience-segmentation criterion. Partner tier is not part of Campaign targeting.</p>

      {error && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      <div className="actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn" onClick={() => setEditing(false)} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={saving || !objective.trim()}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
