"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const active = usePathname() === href;
  return (
    <Link
      href={href}
      className={`rounded-md px-3 py-1.5 text-sm ${active ? "bg-line/60 text-fg" : "text-muted hover:text-fg"}`}
    >
      {children}
    </Link>
  );
}
