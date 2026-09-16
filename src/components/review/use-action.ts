"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Runs one server action, holds its pending and error state, refreshes on
 * success.
 *
 * Every panel at gate two was previously handed `pending` and an `act`
 * callback from the parent, which meant the parent owned state that only the
 * child used, and one channel approving put a spinner on every button in the
 * panel. Each panel now owns its own.
 *
 * The panels depend on this small interface rather than on GateTwo, which is
 * the point: a panel can be rendered anywhere without a parent arranging
 * transitions for it.
 */
export interface ActionState {
  pending: boolean;
  error: string | null;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>) => void;
  clearError: () => void;
}

export function useAction(): ActionState {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error ?? "That did not work.");
      else router.refresh();
    });
  }

  return { pending, error, run, clearError: () => setError(null) };
}
