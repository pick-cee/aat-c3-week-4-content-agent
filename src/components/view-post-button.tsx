"use client";

import { useState } from "react";
import { PostDialog } from "./post-dialog";

/**
 * Opens the post to publish in a dialog.
 *
 * A client island inside the server-rendered queue: the row stays server
 * markup and only the button carries state.
 */
export function ViewPostButton({
  channelLabel,
  subject,
  body,
  hashtags,
  charCount,
  weighted,
}: {
  channelLabel: string;
  subject?: string | null;
  body: string;
  hashtags: string[];
  charCount?: number | null;
  weighted?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="btn btn-sm" onClick={() => setOpen(true)}>
        View the post
      </button>
      <PostDialog
        open={open}
        onClose={() => setOpen(false)}
        channelLabel={channelLabel}
        subject={subject}
        body={body}
        hashtags={hashtags}
        charCount={charCount}
        weighted={weighted}
      />
    </>
  );
}
