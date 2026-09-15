"use client";

import { Icon } from "./icons";

export function Topbar({
  crumb,
  onMenuClick,
}: {
  crumb: string;
  onMenuClick: () => void;
}) {
  return (
    <header className="topbar">
      <button
        className="iconbutton menu"
        aria-label="Open navigation"
        aria-expanded="false"
        onClick={onMenuClick}
      >
        ☰
      </button>
      <div className="crumb">
        Workspace <span style={{ marginLeft: 10, color: "#bbc1c8" }}>/</span>{" "}
        <b>{crumb}</b>
      </div>
      <div className="topactions">
        <button className="searchtrigger" type="button">
          <Icon name="search" />
          <span>Find a module or pattern</span>
          <kbd className="key">⌘ K</kbd>
        </button>
        <span className="sample">ILLUSTRATIVE DATA</span>
        <button className="iconbutton" aria-label="Preview notifications" type="button">
          <Icon name="bell" />
        </button>
        <span className="avatar">SA</span>
      </div>
    </header>
  );
}
