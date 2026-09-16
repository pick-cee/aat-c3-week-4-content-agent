import type { PublishStatus } from "@/lib/db/types";

/**
 * Turning per-recipient outcomes into one queue status.
 *
 * Pure and separate from the worker so it can be tested directly. The rule it
 * exists to hold is DESIGN.md §5.12: a broadcast where some recipients failed
 * is `partially_delivered` with the REAL COUNTS, never a status word alone.
 *
 * `uncertain` is the addition that made this worth extracting. A delivery whose
 * provider never responded is not a success and not a failure — it is a send we
 * cannot account for, and a roll-up that folds it into either direction claims
 * to know something it does not (§15.5, §17).
 */

export interface DeliveryTally {
  /** The provider accepted it, or a webhook confirmed delivery. */
  sent: number;
  /** The provider refused it. Safe to retry. */
  failed: number;
  /** No provider response. NOT safe to retry — it may already have gone. */
  uncertain: number;
  /** No consent on file. Never contacted, and counted rather than dropped. */
  skipped: number;
}

export interface RollUp {
  status: PublishStatus;
  /** One line a person can read, with the real numbers in it. */
  message: string;
  /** True when a human has something to resolve. */
  needsAttention: boolean;
}

export function rollUpDeliveries(tally: DeliveryTally, isDryRun: boolean): RollUp {
  const { sent, failed, uncertain, skipped } = tally;
  const attempted = sent + failed + uncertain;

  // Nothing was attempted: every recipient lacked consent. That is a real
  // outcome with a real reason, not a delivery failure (§9c).
  if (attempted === 0) {
    return {
      status: "failed",
      message:
        skipped > 0
          ? `Nobody was contacted: all ${skipped} recipients are not opted in.`
          : "There were no recipients to send to.",
      needsAttention: true,
    };
  }

  const parts = [`${sent} of ${attempted} delivered`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (uncertain > 0) parts.push(`${uncertain} unknown`);
  if (skipped > 0) parts.push(`${skipped} skipped for consent`);
  const counts = parts.join(", ");

  // Everything accounted for, and all of it went.
  if (failed === 0 && uncertain === 0) {
    const status: PublishStatus = isDryRun ? "published_dry_run" : "published";
    return {
      status,
      message: `${counts}${isDryRun ? " (dry run)" : ""}.`,
      needsAttention: false,
    };
  }

  /**
   * Anything unaccounted for keeps the row honest.
   *
   * `partially_delivered` on the strength of sends we do not know about would
   * be claiming more than we can support — the whole point of `uncertain` is
   * that the outcome is open. The status is the same either way; the MESSAGE
   * is what stops it being a lie, and it names the unknowns explicitly.
   */
  return {
    status: "partially_delivered",
    message:
      uncertain > 0
        ? `${counts}. The unknown ones will not be retried automatically, ` +
          `re-sending a delivery that may already have arrived is how someone ` +
          `receives the same message twice.`
        : `${counts}. A retry will re-send only to the ones that failed.`,
    needsAttention: true,
  };
}

/**
 * Whether a delivery row must be left alone on a retry.
 *
 * `sent` and `delivered` are obvious. `uncertain` is the one that was missing:
 * it was previously recorded as `failed`, so the retry re-sent it and the
 * recipient got the newsletter twice — exactly what rule 9b forbids.
 */
export function isAlreadyHandled(status: string): boolean {
  return status === "sent" || status === "delivered" || status === "uncertain";
}
