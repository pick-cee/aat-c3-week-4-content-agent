"use client";

import { useState } from "react";

/**
 * Copies the exact text that goes on the platform.
 *
 * LinkedIn and X are handoff channels: the system will never post them, so a
 * person takes this text to the platform themselves (§2.11). The post body was
 * shown but not copyable, which left the one action the channel exists for as
 * a manual select-and-drag over a scrolling preview.
 *
 * What is copied is what is stored, which is what a reader sees: markers are
 * already stripped at save time, so there is no risk of an internal `[E12]`
 * reaching a real audience through the clipboard.
 */
export function CopyButton({
  text,
  label,
  className = "btn btn-sm",
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      // Long enough to notice, short enough that the button is ready again.
      setTimeout(() => setState("idle"), 2_000);
    } catch {
      // A denied clipboard permission is not an error worth a banner, but it
      // must not look like success either.
      setState("failed");
    }
  }

  return (
    <button type="button" className={className} onClick={copy} title={label}>
      {state === "copied" ? "Copied" : state === "failed" ? "Select it and copy" : label}
    </button>
  );
}
