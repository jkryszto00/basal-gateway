"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { switchOrganization } from "@/app/org-actions";

type Org = { id: string; name: string; role: string; personal: boolean };

const item = "block w-full rounded px-3 py-2 text-left text-sm hover:bg-line/60";

/** The active organization in the dashboard header: switch between the user's organizations or create one. */
export function OrgSwitcher({ active, orgs }: { active: Org; orgs: Org[] }) {
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
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Organization"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm hover:bg-line/50"
      >
        <span className="max-w-44 truncate">{active.name}</span>
        {active.personal && <span className="text-xs text-muted">personal</span>}
        <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 fill-current text-muted">
          <path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 z-10 mt-1 w-64 rounded-lg border border-line bg-card p-1 shadow-lg">
          <div className="px-3 py-1.5 text-xs text-muted">Organizations</div>
          {orgs.map((o) => (
            <form key={o.id} action={switchOrganization}>
              <input type="hidden" name="organizationId" value={o.id} />
              <button
                type="submit"
                role="option"
                aria-selected={o.id === active.id}
                className={`${item} flex items-center justify-between gap-2`}
              >
                <span className="truncate">{o.name}</span>
                <span className="shrink-0 text-xs text-muted">
                  {o.personal ? "personal" : o.role}
                  {o.id === active.id && " ✓"}
                </span>
              </button>
            </form>
          ))}
          <div className="my-1 h-px bg-line" />
          <Link href="/dashboard/organization/new" className={item} onClick={() => setOpen(false)}>
            New organization
          </Link>
        </div>
      )}
    </div>
  );
}
