"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { signOut } from "@/app/actions";

const item = "block w-full rounded px-3 py-2 text-left text-sm hover:bg-line/60";

/** The account name in the dashboard header; opens Settings and Sign out. */
export function AccountMenu({ name, email }: { name: string; email: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted hover:text-fg"
      >
        <span className="max-w-40 truncate">{name || email}</span>
        <svg viewBox="0 0 16 16" aria-hidden className={`size-3.5 fill-current transition ${open ? "rotate-180" : ""}`}>
          <path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-10 mt-1 w-56 rounded-lg border border-line bg-card p-1 shadow-lg">
          <div className="truncate px-3 py-2 text-xs text-muted">{email}</div>
          <div className="my-1 h-px bg-line" />
          <Link href="/dashboard/settings" role="menuitem" className={item} onClick={() => setOpen(false)}>
            Settings
          </Link>
          <form action={signOut}>
            <button type="submit" role="menuitem" className={item}>
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
