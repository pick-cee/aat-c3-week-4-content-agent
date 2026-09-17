import Link from "next/link";
import { CHANNEL_LABELS } from "../status";
import type { ChannelOutput } from "@/lib/db/types";

/**
 * The one line that says what still needs a person.
 *
 * Status and what-needs-me first (§16). Without it the screen opened with a
 * stepper and two dense panes and left the reviewer to count status pills
 * across both to notice an undecided channel.
 */
export function NextAction({
  outputs,
  channelsLocked,
  articleLocked,
  status,
  onOpenChannels,
}: {
  outputs: ChannelOutput[];
  channelsLocked: boolean;
  articleLocked: boolean;
  status: string;
  onOpenChannels: () => void;
}) {
  if (channelsLocked || outputs.length === 0) return null;

  const undecided = outputs.filter((o) => o.status === "draft" || o.status === "format_failed");
  const approved = outputs.filter((o) => o.status === "approved");

  if (undecided.length === 0) {
    /**
     * Done, and a way out.
     *
     * This said "nothing else needs you here" and then offered nowhere to go:
     * the reviewer finished the work and landed in a dead end, with the
     * browser back button as the only exit. Finishing a task should hand you
     * the next one.
     */
    return (
      <div className="alert alert-ok row-between" style={{ alignItems: "center" }}>
        <span>
          <strong>Every channel is decided.</strong>{" "}
          {approved.length > 0
            ? `${approved.length} approved and waiting in the queue.`
            : "Nothing was approved, so nothing will go out."}
        </span>
        <span className="row nowrap" style={{ gap: 6 }}>
          {approved.length > 0 && (
            <Link href="/queue" className="btn btn-sm btn-primary">
              See the queue
            </Link>
          )}
          <Link href="/" className="btn btn-sm">
            Back to dashboard
          </Link>
        </span>
      </div>
    );
  }

  const names = undecided.map((o) => CHANNEL_LABELS[o.channel]).join(" and ");

  return (
    <div className="alert alert-warn row-between" style={{ alignItems: "center" }}>
      <span>
        <strong>
          {undecided.length} channel{undecided.length === 1 ? "" : "s"} still need
          {undecided.length === 1 ? "s" : ""} you:
        </strong>{" "}
        {names}.
        {approved.length > 0 && ` ${approved.length} already approved.`}
        {articleLocked && " The article is locked because something was approved from it."}
      </span>
      <button className="btn btn-sm btn-primary nowrap" onClick={onOpenChannels}>
        Review {undecided.length === 1 ? "it" : "them"}
      </button>
    </div>
  );
}
