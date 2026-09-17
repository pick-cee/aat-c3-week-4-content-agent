"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { currentStepLabel } from "./stepper";
import type { RequestStatus } from "@/lib/db/types";

type Progress = { status: RequestStatus; current_step: string | null; step_attempts: number; step_started_at: string | null; retry_after: string | null; runner_lease_until: string | null; actual_cost_cents: number };
const RUNNING = new Set(["researching", "drafting", "evaluating", "revising", "adapting"]);

/** Poll inexpensive progress reads. Work lives on the server, independently of this tab. */
export function RunnerPoll({ requestId, status, step, startedAt }: { requestId: string; status: RequestStatus; step?: string | null; startedAt?: string | null }) {
  const router = useRouter();
  const [progress, setProgress] = useState<Progress>({ status, current_step: step ?? null, step_attempts: 0, step_started_at: startedAt ?? null, retry_after: null, runner_lease_until: null, actual_cost_cents: 0 });
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [reconnect, setReconnect] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let lastSignature = "";
    let lastWake = 0;
    let failures = 0;
    const controller = new AbortController();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    async function poll() {
      if (stopped) return;
      if (document.visibilityState !== "visible") { timer = setTimeout(poll, 3000); return; }
      try {
        const response = await fetch(`/api/runner?requestId=${requestId}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (stopped) return;
        if (response.status === 401 || response.status === 403) { setError("Your session has ended. Sign in again to see progress."); router.refresh(); return; }
        if (response.status === 404) { router.refresh(); return; }
        if (!response.ok) throw new Error("Progress unavailable");
        const next: Progress = await response.json();
        if (stopped) return;
        failures = 0;
        setError(null);
        setProgress(next);
        const signature = `${next.status}:${next.current_step}:${next.actual_cost_cents}:${next.step_attempts}`;
        if (lastSignature !== signature) { lastSignature = signature; router.refresh(); }
        if (!RUNNING.has(next.status)) return;
        const time = Date.now();
        const leased = next.runner_lease_until && Date.parse(next.runner_lease_until) > time;
        const waiting = next.retry_after && Date.parse(next.retry_after) > time;
        if (!leased && !waiting && time - lastWake > 15_000) {
          lastWake = time;
          const wake = await fetch("/api/runner", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
          if (!wake.ok) throw new Error("Could not resume work");
        }
      } catch {
        if (stopped) return;
        failures++;
        if (failures >= 2) setError("Connection interrupted. Your saved work is safe. Reconnecting…");
      }
      if (!stopped) timer = setTimeout(poll, Math.min(15_000, 2000 * Math.max(1, failures)));
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); clearInterval(clock); controller.abort(); };
  }, [requestId, router, reconnect]);

  const seconds = progress.step_started_at && now ? Math.max(0, Math.floor((now - Date.parse(progress.step_started_at)) / 1000)) : 0;
  const waiting = progress.retry_after && Date.parse(progress.retry_after) > now;
  return <div className="progress-banner" role="status"><span className="spin" /><div><h2>{error ? "Reconnecting to your workspace" : currentStepLabel(progress.status, progress.current_step)}</h2><p>{error ?? (waiting ? "A provider is temporarily unavailable. A retry is scheduled; no action needed." : "Progress is saved as we go. Your draft will appear here as soon as it is written.")}</p>{error && <button className="btn btn-sm mt-1" onClick={()=>setReconnect(v=>v+1)}>Reconnect now</button>}</div><span className="progress-elapsed">{seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`}{progress.step_attempts > 1 ? ` · attempt ${progress.step_attempts}/3` : ""}</span></div>;
}
