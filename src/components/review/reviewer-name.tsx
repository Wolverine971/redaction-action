"use client";

import { useState, useSyncExternalStore } from "react";

const COOKIE = "reviewer";
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function readReviewer(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|; )reviewer=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function writeReviewer(name: string) {
  document.cookie = `${COOKIE}=${encodeURIComponent(name)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  listeners.forEach((cb) => cb());
}

/**
 * Who is making decisions. There's no login in this version; the name is stored in a cookie and
 * stamped on every audit entry. `prompt` shows it as a dialog before the first decision.
 */
export function ReviewerName({ prompt, onDone, onCancel }: { prompt?: boolean; onDone?: () => void; onCancel?: () => void }) {
  const name = useSyncExternalStore(subscribe, readReviewer, () => "");
  const [editing, setEditing] = useState(false);

  const save = (value: string) => {
    const v = value.trim();
    if (!v) return;
    writeReviewer(v);
    setEditing(false);
    onDone?.();
  };

  if (prompt) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onCancel}>
        <form
          role="dialog"
          aria-label="Your name"
          className="w-full max-w-sm rounded-xl bg-paper p-6 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            save(new FormData(e.currentTarget).get("name") as string);
          }}
        >
          <h2 className="font-semibold">Who&apos;s reviewing?</h2>
          <p className="mt-1 text-sm text-muted">Every decision is recorded in the audit log with your name and the time.</p>
          <input
            name="name"
            autoFocus
            defaultValue={name}
            placeholder="Your name"
            className="mt-4 w-full rounded-lg border border-line px-3 py-2 outline-none focus:border-focus"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm hover:bg-background">
              Cancel
            </button>
            <button className="rounded-lg bg-ink px-4 py-1.5 text-sm font-medium text-white">Continue</button>
          </div>
        </form>
      </div>
    );
  }

  if (editing || !name) {
    return (
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          save(new FormData(e.currentTarget).get("name") as string);
        }}
      >
        <input
          name="name"
          defaultValue={name}
          autoFocus={editing}
          placeholder="Your name"
          className="w-32 rounded-lg border border-line px-2 py-1.5 outline-none focus:border-focus"
        />
      </form>
    );
  }
  return (
    <button onClick={() => setEditing(true)} className="rounded-lg px-2 py-1.5 text-muted hover:bg-background" title="Change reviewer">
      Reviewing as <span className="font-medium text-foreground">{name}</span>
    </button>
  );
}
