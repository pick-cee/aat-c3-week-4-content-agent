import Link from "next/link";
import { currentProfile } from "@/lib/db/client";
import { env } from "@/lib/env";
import { ReleaseHeartbeat } from "@/components/release-heartbeat";

/**
 * The signed-in workspace: nav, identity, demo badge.
 *
 * Deliberately NOT in the root layout. Public pages (`/a/[slug]`, `/confirm`,
 * `/unsubscribe`) are read by people who have no account here, and showing
 * them a dashboard nav and the reviewer's name is both confusing and a small
 * leak of who works on what.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
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
        <div className="shell">
          <header className="topbar">
            <div className="topbar-inner">
              <Link href="/" className="brand">
                {/* A mark rather than a bare word, so the product has an
                    identity in the corner the way a tool people keep open
                    all day does. */}
                <span className="brand-mark" aria-hidden="true">
                  K
                </span>
                Koya Content
              </Link>

              {profile ? (
                <nav className="nav">
                  <Link href="/">Dashboard</Link>
                  <Link href="/requests/new">New request</Link>
                  <Link href="/queue">Queue</Link>
                  <Link href="/recycle-bin">Recycle bin</Link>
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

          {/* Keeps the schedule from whatever page is open. The external
              workflow is the guarantee; this makes it immediate while someone
              is actually using the app. */}
          <ReleaseHeartbeat />

          <main className="main">{children}</main>
        </div>
  );
}
