// List/feed primitives from the golden master's `.attention` / `.activity` rows.
import { Icon, type IconName } from "./icons";

export function AttentionList({
  items,
}: {
  items: { title: string; detail: string; count: string }[];
}) {
  return (
    <>
      {items.map((item) => (
        <div className="attention" key={item.title}>
          <span className="alerttile">
            <Icon name="alert" />
          </span>
          <div className="grow">
            <strong>{item.title}</strong>
            <small>{item.detail}</small>
          </div>
          <span className="count">{item.count}</span>
          <span className="arrow">→</span>
        </div>
      ))}
    </>
  );
}

export function ActivityList({ items }: { items: { title: string; detail: string }[] }) {
  return (
    <>
      {items.map((item) => (
        <div className="activity" key={item.title}>
          <span className="eventdot" />
          <div>
            <b>{item.title}</b>
            <small>{item.detail}</small>
          </div>
        </div>
      ))}
    </>
  );
}

export function RankList({ items }: { items: { rank: number; name: string; value: string }[] }) {
  return (
    <>
      {items.map((item) => (
        <div className="attention" key={item.name}>
          <span className="alerttile">{item.rank}</span>
          <div className="grow">
            <strong>{item.name}</strong>
          </div>
          <span className="count">{item.value}</span>
        </div>
      ))}
    </>
  );
}

export function ActionRow({ actions }: { actions: { label: string; icon: IconName }[] }) {
  return (
    <div className="actiongrid">
      {actions.map((action) => (
        <button className="btn" type="button" key={action.label}>
          <Icon name={action.icon} />
          {action.label}
        </button>
      ))}
    </div>
  );
}
