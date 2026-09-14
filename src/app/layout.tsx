import type { Metadata } from "next";
import Link from "next/link";
import { currentProfile } from "@/lib/db/client";
import { env } from "@/lib/env";
import "./globals.css";

export const metadata: Metadata = {
  title: "Koya Content Agent",
  description:
    "Research, draft, evaluate and publish channel-ready content, grounded in sources you can check.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Must not throw when signed out or when the database is unreachable: the
  // app has to load for a signed-out visitor on a machine that is not ours
  // (§20).
  let profile: Awaited<ReturnType<typeof currentProfile>> = null;
  try {
    profile = await currentProfile();
  } catch {
    profile = null;
  }

  const demoMode = env.app.demoMode;

  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <div className="topbar-inner">
              <Link href="/" className="brand">
                Koya Content
              </Link>

              {profile ? (
                <nav className="nav">
                  <Link href="/">Dashboard</Link>
                  <Link href="/requests/new">New request</Link>
                  <Link href="/queue">Queue</Link>
                  <Link href="/settings">Settings</Link>
                </nav>
              ) : (
                <nav className="nav" />
              )}

              <div className="row">
                {demoMode && (
                  <span
                    className="pill pill-warn"
                    title="Nothing is sent to real recipients. Every send is stored as a dry run."
                  >
                    Demo mode
                  </span>
                )}
                {profile ? (
                  <span className="small muted nowrap">
                    {profile.full_name ?? profile.email}
                    <span className="dim"> · {profile.role}</span>
                  </span>
                ) : null}
              </div>
            </div>
          </header>

          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
