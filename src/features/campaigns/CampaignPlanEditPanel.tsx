"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { Field, Fields } from "@/ui/Form";
import { Icon } from "@/ui/icons";
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

const PLATFORM_SUGGESTIONS = ["Instagram", "YouTube"];

// A real multi-selection dropdown: a closed control that shows the
// current selection, opens a checkbox list on click, and closes on an
// outside click - never a native unstyled <datalist> popup, never a
// native <select multiple> listbox (which never closes and needs
// ctrl/cmd-click). Free text stays possible via the "Other platform"
// row at the bottom, so this is still never a fixed whitelist. Mirrors
// CampaignForm.tsx's own PlatformMultiSelect exactly.
function PlatformMultiSelect({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutsideClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [open]);

  const selectedValues = fromCsv(value);
  const selectedLower = new Set(selectedValues.map((v) => v.toLowerCase()));
  const extraSelected = selectedValues.filter((v) => !PLATFORM_SUGGESTIONS.some((p) => p.toLowerCase() === v.toLowerCase()));

  function toggle(name: string) {
    const already = selectedLower.has(name.toLowerCase());
    const next = already ? selectedValues.filter((v) => v.toLowerCase() !== name.toLowerCase()) : [...selectedValues, name];
    onChange(next.join(", "));
  }

  function addCustom() {
    const trimmed = customInput.trim();
    if (!trimmed || selectedLower.has(trimmed.toLowerCase())) return;
    onChange([...selectedValues, trimmed].join(", "));
    setCustomInput("");
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          textAlign: "left",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          border: "1px solid #dce1e7",
          borderRadius: 6,
          padding: "8px 10px",
          background: "white",
          color: "var(--ink)",
          fontSize: 12,
        }}
      >
        <span>{selectedValues.length > 0 ? selectedValues.join(", ") : "Select platforms…"}</span>
        <Icon name="chevronDown" className="muted" style={{ width: 14, height: 14, flexShrink: 0 }} />
      </button>
      {open && (
        <div className="panel" role="listbox" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 20, padding: 10 }}>
          {[...PLATFORM_SUGGESTIONS, ...extraSelected].map((p) => (
            <label key={p} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 4px", cursor: "pointer" }}>
              <input type="checkbox" checked={selectedLower.has(p.toLowerCase())} onChange={() => toggle(p)} />
              {p}
            </label>
          ))}
          <div className="actions" style={{ marginTop: 8 }}>
            <input
              type="text"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustom();
                }
              }}
              placeholder="Other platform…"
              style={{ flex: 1 }}
            />
            <button type="button" className="btn" onClick={addCustom}>
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

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
        <Field label="Platforms" full>
          <PlatformMultiSelect value={platforms} onChange={setPlatforms} />
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
        <Field label="Targeting platforms" full>
          <PlatformMultiSelect value={criteriaPlatforms} onChange={setCriteriaPlatforms} />
        </Field>
        <Field label="Default review policy">
          <select value={reviewPolicy} onChange={(e) => setReviewPolicy(e.target.value as CampaignDto["defaultReviewPolicy"])}>
            <option value="REVIEW_REQUIRED">{REVIEW_POLICY_LABELS.REVIEW_REQUIRED}</option>
            <option value="NO_PREPOST_REVIEW">{REVIEW_POLICY_LABELS.NO_PREPOST_REVIEW}</option>
          </select>
        </Field>
      </Fields>
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
