// Renders a server-returned EffectiveAccessDto exactly as computed by the
// shared enforcement primitives (getAllowedFeatures / getActorScopeGrants /
// the accessGrants + sensitiveAccessGrants reads) - this component performs
// no access-decision logic of its own, it only formats what the server
// already decided.
import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import type { EffectiveAccessDto } from "@/server/administration/effective-access-service";
import { FEATURE_LABELS } from "@/server/authz/features";
import { ROLE_LABELS } from "@/server/authz/roles";
import { formatActionLabel, scopeChips } from "./format";

export function EffectiveAccessPanel({ data, span = 8 }: { data: EffectiveAccessDto; span?: 3 | 4 | 5 | 6 | 7 | 8 | 12 }) {
  const chips = scopeChips(data.scope);
  const grantedFeatures = data.activeFeatures;

  return (
    <Panel span={span}>
      <PanelHead title="Effective access" description={`Resolved live from the same primitives that enforce every request - ${ROLE_LABELS[data.role]}, ${data.active ? "active" : "inactive"}.`} />
      <PanelBody>
        <div className="kv">
          <span>Role</span>
          <b>{ROLE_LABELS[data.role]}</b>
        </div>
        <div className="kv">
          <span>Admission</span>
          <b>{data.active ? "Active" : "Inactive"}</b>
        </div>

        <h3 style={{ marginTop: 18, marginBottom: 8 }}>Feature access</h3>
        {grantedFeatures.length === 0 ? (
          <small>No feature access granted.</small>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {grantedFeatures.map((feature) => {
              const actions = Object.entries(data.features[feature]?.actions ?? {}).filter(([, allowed]) => allowed);
              return (
                <div className="kv" key={feature} style={{ gridTemplateColumns: "160px 1fr" }}>
                  <span>{FEATURE_LABELS[feature]}</span>
                  <span>
                    {actions.length === 0 ? (
                      <small>View only</small>
                    ) : (
                      actions.map(([action]) => (
                        <Pill tone="blue" key={action}>
                          {formatActionLabel(action)}
                        </Pill>
                      ))
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <h3 style={{ marginTop: 18, marginBottom: 8 }}>Scope grants</h3>
        {chips.length === 0 ? (
          <small>No scope grants - this actor can reach zero records regardless of feature access.</small>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {chips.map((chip) => (
              <Pill tone={chip.kind === "global" ? "orange" : "gray"} key={chip.label}>
                {chip.label}
              </Pill>
            ))}
          </div>
        )}

        <h3 style={{ marginTop: 18, marginBottom: 8 }}>Sensitive-access categories</h3>
        {data.sensitiveCategories.length === 0 ? (
          <small>No sensitive categories granted to this role.</small>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {data.sensitiveCategories.map((category) => (
              <Pill tone="purple" key={category}>
                {category}
              </Pill>
            ))}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}
