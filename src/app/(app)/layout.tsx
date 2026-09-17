import Link from "next/link";
import { currentProfile } from "@/lib/db/client";
import { env } from "@/lib/env";
import { ReleaseHeartbeat } from "@/components/release-heartbeat";
import { WorkspaceNav } from "@/components/workspace-nav";

export const maxDuration = 300;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await currentProfile().catch(() => null);
  if (!profile) return <div className="guest-shell"><header className="guest-header"><Link href="/" className="brand"><span className="brand-mark">k.</span>Koya<span className="brand-descriptor">studio</span></Link><span className="small muted">The content workspace for ambitious teams</span></header><main>{children}</main></div>;
  return <div className="workspace-shell">
    <a href="#main-content" className="skip-link">Skip to content</a>
    <WorkspaceNav name={profile.full_name ?? profile.email} role={profile.role} demo={env.app.demoMode} />
    <ReleaseHeartbeat />
    <main id="main-content" className="workspace-main">{children}</main>
  </div>;
}
