"use client";

import { Icon } from "./icons";

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
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
      <div className="topactions" style={{ marginLeft: "auto" }}>
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
