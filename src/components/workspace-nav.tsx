"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon } from "./icon";
import { signOut } from "@/app/actions/auth";

export function WorkspaceNav({ name, role, demo }: { name: string; role: string; demo: boolean }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const links = [
    { href: "/", label: "Content library", icon: "grid" as const },
    { href: "/queue", label: "Publishing queue", icon: "calendar" as const },
    { href: "/settings", label: "Workspace settings", icon: "settings" as const },
    { href: "/recycle-bin", label: "Recycle bin", icon: "trash" as const },
  ];
  return <>
    <div className="mobile-bar"><Link href="/" className="brand"><span className="brand-mark">k.</span>Koya<span className="brand-descriptor">studio</span></Link><button className="btn btn-ghost" aria-label={open ? "Close navigation" : "Open navigation"} aria-expanded={open} aria-controls="workspace-sidebar" onClick={() => setOpen(!open)}><Icon name={open ? "close" : "menu"} /></button></div>
    {open && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setOpen(false)} />}
    <aside id="workspace-sidebar" className={`sidebar ${open ? "is-open" : ""}`}>
      <Link href="/" className="brand" onClick={() => setOpen(false)}><span className="brand-mark">k.</span>Koya<span className="brand-descriptor">studio</span></Link>
      <div className="workspace-switch"><span className="workspace-monogram">K</span><span><strong>Koya Content</strong><small>Editorial workspace</small></span><span className="workspace-dot" /></div>
      <Link href="/requests/new" className="btn btn-primary compose-button" onClick={() => setOpen(false)}><Icon name="plus" size={18} />Create content</Link>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Workspace">{links.map(link => <Link key={link.href} href={link.href} aria-current={path === link.href || (link.href !== "/" && path.startsWith(link.href)) ? "page" : undefined} onClick={() => setOpen(false)}><Icon name={link.icon} size={18} />{link.label}</Link>)}</nav>
      <div className="sidebar-note"><Icon name="book" /><strong>Your ideas. Your final say.</strong><p>Research, write, and prepare each channel in one place. You approve what goes out.</p>{demo && <span className="pill pill-warn">Demo · delivery disabled</span>}</div>
      <div className="sidebar-profile"><span className="avatar">{name.split(/\s+/).slice(0,2).map(s=>s[0]).join("").toUpperCase()}</span><div><strong>{name}</strong><small>{role}</small></div><form action={signOut}><button className="signout" title="Sign out" aria-label="Sign out">↗</button></form></div>
    </aside>
  </>;
}
