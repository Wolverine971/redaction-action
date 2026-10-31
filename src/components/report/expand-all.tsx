"use client";

import { useState } from "react";

/** Opens or closes every entity on the report at once. */
export function ExpandAll() {
  const [open, setOpen] = useState(false);
  return (
    <button
      className="rounded-md border border-line bg-paper px-2.5 py-1 text-xs font-medium hover:bg-background"
      onClick={() => {
        const next = !open;
        document.querySelectorAll<HTMLDetailsElement>("details[data-entity]").forEach((d) => (d.open = next));
        setOpen(next);
      }}
    >
      {open ? "Collapse all" : "Expand all"}
    </button>
  );
}
