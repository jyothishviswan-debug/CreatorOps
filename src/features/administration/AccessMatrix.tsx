"use client";

// The hierarchical Administration access-matrix editor: Base Role → bulk
// module controls → module-by-module access → expand a module → its own
// meaningful actions → effective access. Every value shown here is
// exactly what the server-returned EffectiveAccessDto says - this
// component performs no access-decision logic of its own, it only
// renders the server's baseline/override/effective/source and submits
// tri-state changes through the trusted Administration API.
import { Fragment, useState } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { FEATURES, FEATURE_LABELS, type FeatureId } from "@/server/authz/features";
import type { ActionId } from "@/server/authz/actions";
import { MODULE_ACTIONS } from "@/server/authz/module-actions";
import { ROLE_LABELS } from "@/server/authz/roles";
import type { EffectiveAccessDto, EffectiveSource } from "@/server/administration/effective-access-service";
import { bulkSetAccessOverrides, setAccessOverride } from "./api-client";

type OverrideValue = "inherit" | "allow" | "deny";

function sourceTone(source: EffectiveSource): "gray" | "default" | "red" {
  if (source === "override_allow") return "default";
  if (source === "override_deny" || source === "override_invalid") return "red";
  return "gray";
}

function sourceLabel(source: EffectiveSource): string {
  if (source === "override_allow") return "Explicit allow";
  if (source === "override_deny") return "Explicit deny";
  if (source === "override_invalid") return "Denied - invalid override data";
  return "Role default";
}

// One tick-mark cell per tri-state column (Inherit / Allow / Deny) - the
// active state shows a check, the other two columns are empty, tappable
// targets. Three columns read left-to-right at a glance across many
// module rows, rather than a button-segment control repeated per row.
function TickCell({ active, onClick, disabled, label }: { active: boolean; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <td style={{ textAlign: "center" }}>
      <button
        type="button"
        className="iconbutton"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        style={active ? { background: "var(--tint)", borderColor: "#f0b48a", color: "var(--orange)", fontWeight: 700 } : undefined}
      >
        {active ? "✓" : ""}
      </button>
    </td>
  );
}

function TickRow({ value, onChange, disabled, rowLabel }: { value: OverrideValue; onChange: (next: OverrideValue) => void; disabled?: boolean; rowLabel: string }) {
  return (
    <>
      <TickCell active={value === "inherit"} disabled={disabled} label={`${rowLabel}: set to Inherit`} onClick={() => onChange("inherit")} />
      <TickCell active={value === "allow"} disabled={disabled} label={`${rowLabel}: set to Allow`} onClick={() => onChange("allow")} />
      <TickCell active={value === "deny"} disabled={disabled} label={`${rowLabel}: set to Deny`} onClick={() => onChange("deny")} />
    </>
  );
}

export function AccessMatrix({ userRef, data, onRefresh }: { userRef: string; data: EffectiveAccessDto; onRefresh: () => void | Promise<void> }) {
  const [expanded, setExpanded] = useState<Set<FeatureId>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  function toggleExpanded(feature: FeatureId) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(feature)) next.delete(feature);
      else next.add(feature);
      return next;
    });
  }

  async function handleModuleOverride(feature: FeatureId, value: OverrideValue) {
    const key = `module:${feature}`;
    setBusyKey(key);
    setError(null);
    const result = await setAccessOverride(userRef, { featureId: feature, value, expectedVersion: data.overridesVersion });
    setBusyKey(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await onRefresh();
  }

  async function handleActionOverride(feature: FeatureId, actionId: ActionId, value: OverrideValue) {
    const key = `action:${feature}:${actionId}`;
    setBusyKey(key);
    setError(null);
    const result = await setAccessOverride(userRef, { featureId: feature, actionId, value, expectedVersion: data.overridesVersion });
    setBusyKey(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await onRefresh();
  }

  async function handleBulk(mode: "allow_all" | "deny_all" | "reset_all") {
    const summary =
      mode === "allow_all"
        ? "Allow every module for this user? Existing action-level overrides are kept."
        : mode === "deny_all"
          ? "Deny every module for this user? Existing action-level overrides are kept, but become moot while their module is denied."
          : "Reset every module and action to this user's role defaults? All overrides for this user will be cleared.";
    if (!window.confirm(summary)) return;

    setBulkBusy(true);
    setError(null);
    const result = await bulkSetAccessOverrides(userRef, { mode, expectedVersion: data.overridesVersion });
    setBulkBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await onRefresh();
  }

  return (
    <Panel span={12}>
      <PanelHead
        title="Access matrix"
        description={`${ROLE_LABELS[data.role]} baseline, with this user's own overrides layered on top - ${data.active ? "active" : "inactive"}.`}
      />
      <PanelBody>
        <div className="toolbar" style={{ padding: 0, marginBottom: 16 }}>
          <button className="btn" type="button" disabled={bulkBusy} onClick={() => handleBulk("allow_all")}>
            Allow All Modules
          </button>
          <button className="btn" type="button" disabled={bulkBusy} onClick={() => handleBulk("deny_all")}>
            Deny All Modules
          </button>
          <button className="btn" type="button" disabled={bulkBusy} onClick={() => handleBulk("reset_all")}>
            Reset All to Role Defaults
          </button>
        </div>

        {data.overrideProfileStatus === "invalid" && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }}>
            <b>This user&rsquo;s override data is invalid.</b> Every module and action below is denied until it&rsquo;s corrected - use Reset All to Role Defaults, or set any module/action here to replace it with a valid one.
          </div>
        )}

        {error && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}

        <div className="tablewrap">
          <table>
            <caption className="sr">Module access matrix</caption>
            <thead>
              <tr>
                <th>Module</th>
                <th>Role Baseline</th>
                <th style={{ textAlign: "center" }}>Inherit</th>
                <th style={{ textAlign: "center" }}>Allow</th>
                <th style={{ textAlign: "center" }}>Deny</th>
                <th>Effective</th>
                <th>
                  <span className="sr">Expand</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {FEATURES.map((feature) => {
                const entry = data.modules[feature];
                const actions = MODULE_ACTIONS[feature];
                const isExpanded = expanded.has(feature);
                const moduleBusy = busyKey === `module:${feature}`;
                return (
                  <Fragment key={feature}>
                    <tr>
                      <td>
                        <b>{FEATURE_LABELS[feature]}</b>
                      </td>
                      <td>
                        <Pill tone={entry.roleBaseline ? "default" : "gray"}>{entry.roleBaseline ? "Allowed" : "Denied"}</Pill>
                      </td>
                      <TickRow value={entry.override} disabled={moduleBusy} rowLabel={FEATURE_LABELS[feature]} onChange={(value) => handleModuleOverride(feature, value)} />
                      <td>
                        <Pill tone={sourceTone(entry.effective.source)}>{entry.effective.value ? "Allowed" : "Denied"}</Pill>
                        <small style={{ display: "block", marginTop: 3 }}>{sourceLabel(entry.effective.source)}</small>
                      </td>
                      <td>
                        {actions.length > 0 && (
                          <button className="iconbutton" type="button" aria-expanded={isExpanded} aria-label={`${isExpanded ? "Collapse" : "Expand"} ${FEATURE_LABELS[feature]} actions`} onClick={() => toggleExpanded(feature)}>
                            {isExpanded ? "−" : "+"}
                          </button>
                        )}
                      </td>
                    </tr>
                    {isExpanded &&
                      actions.map((action) => {
                        const actionEntry = entry.actions[action.id];
                        if (!actionEntry) return null;
                        const actionBusy = busyKey === `action:${feature}:${action.id}`;
                        return (
                          <tr key={`${feature}-${action.id}`} style={{ background: "#fafbfc" }}>
                            <td style={{ paddingLeft: 34 }}>{action.label}</td>
                            <td>
                              <Pill tone={actionEntry.roleBaseline ? "default" : "gray"}>{actionEntry.roleBaseline ? "Allowed" : "Denied"}</Pill>
                            </td>
                            <TickRow
                              value={actionEntry.override}
                              disabled={actionBusy || !entry.effective.value}
                              rowLabel={`${FEATURE_LABELS[feature]}: ${action.label}`}
                              onChange={(value) => handleActionOverride(feature, action.id, value)}
                            />
                            <td>
                              <Pill tone={sourceTone(actionEntry.effective.source)}>{actionEntry.effective.value ? "Allowed" : "Denied"}</Pill>
                              <small style={{ display: "block", marginTop: 3 }}>{!entry.effective.value ? "Module denied" : sourceLabel(actionEntry.effective.source)}</small>
                            </td>
                            <td />
                          </tr>
                        );
                      })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </PanelBody>
    </Panel>
  );
}
