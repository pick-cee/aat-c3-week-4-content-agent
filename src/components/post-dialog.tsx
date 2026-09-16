"use client";

import { useEffect, useRef } from "react";
import { CopyButton } from "./review/copy-button";

/**
 * The post to publish, in a dialog.
 *
 * It was an inline `<details>`, so opening one shoved every row beneath it
 * down the page and a long LinkedIn post pushed the rest of the queue off
 * screen entirely. Reading the thing you are about to publish should not
 * rearrange the list you are working through.
 *
 * `<dialog>` rather than a hand-rolled overlay: it takes the top layer, traps
 * focus, closes on Escape, and returns focus where it came from, all without
 * JavaScript reimplementing any of it.
 */
export function PostDialog({
  open,
  onClose,
  channelLabel,
  subject,
  body,
  hashtags,
  charCount,
  weighted,
}: {
  open: boolean;
  onClose: () => void;
  channelLabel: string;
  subject?: string | null;
  body: string;
  hashtags: string[];
  charCount?: number | null;
  /** X counts a URL as 23 characters however long it is. */
  weighted?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // Escape and the backdrop both fire `close`, so the parent state follows the
  // element rather than trying to predict it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handle = () => onClose();
    el.addEventListener("close", handle);
    return () => el.removeEventListener("close", handle);
  }, [onClose]);

  const missing = hashtags.filter((tag) => !body.includes(tag));
  const full = [subject ? `${subject}\n` : "", body, missing.length ? `\n${missing.join(" ")}` : ""]
    .join("\n")
    .trim();

  return (
    <dialog ref={ref} className="post-dialog" onClick={(e) => {
      // A click on the backdrop lands on the dialog itself, never a child.
      if (e.target === ref.current) ref.current?.close();
    }}>
      <div className="post-dialog-head">
        <div className="min-w-0">
          <h2 style={{ fontSize: 15 }}>{channelLabel}</h2>
          <div className="tiny dim">
            Copy this and post it. Nothing is marked posted until you confirm.
            {charCount != null && ` · ${charCount} characters${weighted ? " (weighted)" : ""}`}
          </div>
        </div>
        <button className="btn btn-sm btn-ghost" onClick={() => ref.current?.close()}>
          Close
        </button>
      </div>

      <div className="post-dialog-body">
        {subject && (
          <div className="mb-2">
            <div className="tiny dim mb-1">Subject</div>
            <div className="preview small">{subject}</div>
          </div>
        )}

        <div className="tiny dim mb-1">The post</div>
        {/* pre-wrap: the line breaks are part of the post, not decoration. */}
        <div className="preview small" style={{ whiteSpace: "pre-wrap" }}>
          {body}
          {missing.length > 0 && `\n\n${missing.join(" ")}`}
        </div>
      </div>

      <div className="post-dialog-foot">
        <CopyButton text={full} label={`Copy for ${channelLabel}`} className="btn btn-primary btn-sm" />
        <span className="tiny dim">
          Markers are already stripped, so what you copy is what a reader sees.
        </span>
      </div>
    </dialog>
  );
}
