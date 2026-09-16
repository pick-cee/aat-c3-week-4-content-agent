"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { confirmHandoff } from "@/app/actions/handoff";

export function ConfirmForm({
  token,
  channel,
  body,
}: {
  token: string;
  channel: string;
  body: string;
}) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  async function copy() {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access can be refused; the text is selectable either way.
      setError("Could not copy automatically, select the text above and copy it.");
    }
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await confirmHandoff(token, url);
      if (!result.ok) setError(result.error ?? "That did not work.");
      else router.refresh();
    });
  }

  return (
    <>
      <button className="btn btn-sm mb-2" onClick={copy} type="button">
        {copied ? "Copied" : `Copy the ${channel} post`}
      </button>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="field">
        <label htmlFor="url">The URL of the post, once it is live</label>
        <input
          id="url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          onKeyDown={(e) => e.key === "Enter" && url.trim() && submit()}
        />
        <div className="hint">
          This is what moves it from awaiting posting to posted. Without it, the queue keeps
          showing that nobody has posted yet, which is the truth until you do.
        </div>
      </div>

      <button
        className="btn btn-primary"
        onClick={submit}
        disabled={pending || !url.trim()}
        type="button"
      >
        {pending ? <span className="spin" /> : "Confirm it is posted"}
      </button>
    </>
  );
}
