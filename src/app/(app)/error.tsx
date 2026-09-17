"use client";
export default function WorkspaceError({ reset }: { reset: () => void }) {
  return <div className="empty card"><h2>We couldn’t load this view.</h2><p>Your saved work is still in the workspace. Try again in a moment.</p><button className="btn btn-primary" onClick={reset}>Try again</button></div>;
}
