import "server-only";
import { serviceClient, table } from "@/lib/db/client";
import { logError, logInfo, logWarn } from "@/lib/log";
import { sendEmail, getEmailStatus } from "@/lib/providers/resend";
import { notifyPublishProblem, sendHandoffPacket } from "@/lib/notify";
import { signHandoffToken } from "@/lib/crypto";
import { renderNewsletterHtml } from "./render";
import { rollUpDeliveries, isAlreadyHandled } from "./rollup";
import { env } from "@/lib/env";
import {
  PUBLISH_BATCH_SIZE,
  PUBLISH_STUCK_MINUTES,
  HANDOFF_REMINDER_HOURS,
} from "@/lib/constants";
import type {
  ChannelName,
  ChannelOutput,
  ConnectorStatus,
  PublishQueueItem,
  PublishStatus,
  Recipient,
} from "@/lib/db/types";

/**
 * The release worker. DESIGN.md §15.
 *
 * Three rules shape everything here:
 *
 *   §15.2 Reserve, then act, then confirm. One statement moves the row out of
 *         `queued`, so two overlapping cron invocations cannot both claim it.
 *
 *   §15.5 A publish whose outcome is unknown is `uncertain`, and is NEVER
 *         retried automatically. "Retrying an unknown write is how you put the
 *         same post on someone's LinkedIn twice."
 *
 *   §2.9  The system never shows a success it did not receive. `published`
 *         requires a provider identifier; a handoff channel can never reach it.
 */

export interface ReleaseResult {
  claimed: number;
  published: number;
  handedOff: number;
  blocked: number;
  failed: number;
  uncertain: number;
  reminded: number;
  messages: string[];
}

export async function runRelease(): Promise<ReleaseResult> {
  const result: ReleaseResult = {
    claimed: 0,
    published: 0,
    handedOff: 0,
    blocked: 0,
    failed: 0,
    uncertain: 0,
    reminded: 0,
    messages: [],
  };

  // The watchdog runs first, so a row stuck from the previous invocation is
  // resolved before new work is claimed.
  result.uncertain = await sweepStuck();
  result.reminded = await remindOverdueHandoffs();

  for (let i = 0; i < PUBLISH_BATCH_SIZE; i++) {
    const item = await claimNext();
    if (!item) break;

    result.claimed++;

    try {
      const outcome = await publishItem(item);
      result.messages.push(outcome.message);

      switch (outcome.status) {
        case "published":
        case "published_dry_run":
        case "partially_delivered":
          result.published++;
          break;
        case "awaiting_manual_post":
          result.handedOff++;
          break;
        case "blocked_not_connected":
          result.blocked++;
          break;
        default:
          result.failed++;
      }
    } catch (err) {
      // An exception here means we do not know whether the send happened.
      // That is `uncertain`, not `failed`, and it is never auto-retried.
      await markUncertain(item, err instanceof Error ? err.message : String(err));
      result.uncertain++;
    }
  }

  return result;
}

/** §15.2: one atomic statement. Read-then-write would lose the race. */
async function claimNext(): Promise<PublishQueueItem | null> {
  const { data, error } = await serviceClient().rpc("claim_due_publish_item");
  if (error || !data) return null;
  return data as unknown as PublishQueueItem;
}

// ─── Publishing one item ────────────────────────────────────────────────────

interface PublishOutcome {
  status: string;
  message: string;
}

async function publishItem(item: PublishQueueItem): Promise<PublishOutcome> {
  const db = serviceClient();

  // §14.3 enforcement point 2: the worker RE-CHECKS approval and refuses
  // otherwise, logging the refusal. The UI is not a security boundary.
  const { error: approvalError } = await db.rpc("assert_output_approved", {
    p_channel_output_id: item.channel_output_id,
  });

  if (approvalError) {
    await setStatus(item, "failed", {
      last_error: `Refused: ${approvalError.message}`,
    });
    await logError(
      "A queued item was refused because its content is not approved.",
      { queueId: item.id, requestId: item.request_id, detail: { error: approvalError.message } },
    );
    return { status: "failed", message: `Refused unapproved ${item.channel} item.` };
  }

  // §15.1: the worker reads `connectors` BEFORE it reads the queue, and
  // branches on `kind`, never on a channel name.
  const connector = await loadConnector(item.channel);

  if (!connector || connector.status !== "connected") {
    await setStatus(item, "blocked_not_connected", {
      status: "blocked_not_connected",
      last_error: connectorReason(connector?.status),
    });
    await notifyPublishProblem(item.id, "blocked", connectorReason(connector?.status));
    return {
      status: "blocked_not_connected",
      message: `${item.channel} is not connected; the item stays queued.`,
    };
  }

  const { data: outputRow } = await db
    .from(table("channel_outputs"))
    .select("*")
    .eq("id", item.channel_output_id)
    .single();

  const output = outputRow as unknown as ChannelOutput;

  return item.kind === "handoff"
    ? dispatchHandoff(item, output, connector)
    : deliverFanOut(item, output);
}

function connectorReason(status: ConnectorStatus | undefined): string {
  switch (status) {
    case "expired": return "The connection expired and needs reconnecting.";
    case "revoked": return "Access was revoked, so nothing can be sent.";
    case "error": return "The connection is in an error state.";
    default: return "No account is connected for this channel yet.";
  }
}

// ─── Handoff: LinkedIn and X (§15.4) ────────────────────────────────────────

/**
 * At the scheduled moment the system does NOT post. It assembles a packet and
 * delivers it to the assigned poster, who confirms with a URL.
 *
 * The item moves to `awaiting_manual_post`. It can never reach `published` —
 * a database check constraint enforces that, not just this code.
 */
async function dispatchHandoff(
  item: PublishQueueItem,
  output: ChannelOutput,
  connector: { handoff_email?: string | null },
): Promise<PublishOutcome> {
  const to = connector.handoff_email || env.app.handoffPosterEmail;

  if (!to) {
    await setStatus(item, "blocked_not_connected", {
      status: "blocked_not_connected",
      last_error: "No one is assigned to post this, so the packet had nowhere to go.",
    });
    await notifyPublishProblem(item.id, "blocked", "No poster is assigned for this channel.");
    return {
      status: "blocked_not_connected",
      message: `${item.channel} has no assigned poster.`,
    };
  }

  // A signed, expiring, single-row token — the one URL a stranger could act
  // on, so it is not a guessable id (§15.4).
  const token = signHandoffToken(item.id, item.channel);
  const confirmUrl = `${env.app.url}/confirm/${token}`;

  const sent = await sendHandoffPacket({
    to,
    channel: item.channel,
    body: output.body,
    subject: output.subject,
    articleUrl: output.link_url,
    charCount: output.char_count ?? output.body.length,
    confirmUrl,
    scheduledFor: item.scheduled_for,
  });

  if (!sent.ok) {
    // The packet did not go, so nobody was asked to post. That is a plain
    // failure, not an uncertain one — nothing was published either way.
    await setStatus(item, "failed", {
      status: "failed",
      last_error: `The packet could not be delivered: ${sent.error}`,
    });
    await notifyPublishProblem(item.id, "failed", sent.error ?? "unknown error");
    return { status: "failed", message: `Could not hand off ${item.channel}.` };
  }

  await setStatus(item, "awaiting_manual_post", {
    status: "awaiting_manual_post",
    handoff_sent_at: new Date().toISOString(),
    last_error: null,
  });

  await logInfo(
    `Sent the ${item.channel} post to whoever is publishing it. It is not live until they confirm.`,
    { queueId: item.id, requestId: item.request_id },
  );

  return {
    status: "awaiting_manual_post",
    message: `${item.channel} packet sent; awaiting confirmation.`,
  };
}

// ─── Delivering: the newsletter (§15.3) ─────────────────────────────────────

/**
 * The unit of work is a RECIPIENT, not a queue row.
 *
 * `publish_deliveries` is the idempotency record: a retry after a partial
 * failure re-sends only to rows not yet `sent`. Nobody receives the same
 * newsletter twice (§9b, §15.3).
 */
async function deliverFanOut(
  item: PublishQueueItem,
  output: ChannelOutput,
): Promise<PublishOutcome> {
  const db = serviceClient();

  const { data: recipientRows } = await db
    .from(table("recipients"))
    .select("*")
    .eq("channel", item.channel);

  const recipients = (recipientRows ?? []) as unknown as Recipient[];

  if (recipients.length === 0) {
    await setStatus(item, "failed", {
      status: "failed",
      last_error: "There are no recipients on the list for this channel.",
    });
    return { status: "failed", message: "No recipients." };
  }

  const { data: existingRows } = await db
    .from(table("publish_deliveries"))
    .select("recipient_id, status")
    .eq("queue_id", item.id);

  // `uncertain` counts as handled: the provider never told us whether it
  // arrived, so re-sending could deliver it twice (rule 9b, §15.5).
  const alreadyHandled = new Map(
    (existingRows ?? [])
      .filter((r) => isAlreadyHandled(r.status as string))
      .map((r) => [r.recipient_id as string, r.status as string]),
  );

  let sent = 0;
  let failed = 0;
  let uncertain = 0;
  let skipped = 0;

  for (const recipient of recipients) {
    // Never re-send to someone already served, or someone whose outcome we
    // cannot account for. This is the whole point.
    const handled = alreadyHandled.get(recipient.id);
    if (handled) {
      if (handled === "uncertain") uncertain++;
      else sent++;
      continue;
    }

    // §9c: opt-in is checked in the SEND path, not only at import, and a
    // skipped recipient is RECORDED, never silently dropped. Opt-out between
    // approval and send is caught here, which is why it is checked here.
    if (!recipient.opted_in_at || recipient.opt_out_at) {
      await upsertDelivery(item, recipient, {
        status: "skipped_no_optin",
        error_text: recipient.opt_out_at
          ? "This person opted out."
          : "This person never opted in.",
      });
      skipped++;
      continue;
    }

    const result = await sendEmail({
      to: recipient.handle,
      subject: output.subject ?? "An update from Koya",
      html: renderNewsletterHtml(output, recipient),
      text: output.body,
      replyTo: env.resend.replyTo || undefined,
      // Per recipient per queue row, so a retry cannot double-send.
      idempotencyKey: `${item.idempotency_key}:${recipient.id}`,
    });

    await upsertDelivery(item, recipient, {
      status: result.ok ? "sent" : "failed",
      provider_message_id: result.messageId,
      error_text: result.error,
      is_dry_run: result.isDryRun,
      sent_at: result.ok ? new Date().toISOString() : null,
    });

    if (result.ok) sent++;
    else failed++;
  }

  // §15.3 step 4. The counts are shown, never a status word alone (§5.12).
  const isDryRun = env.app.demoMode;
  const outcome = rollUpDeliveries({ sent, failed, uncertain, skipped }, isDryRun);

  const succeeded =
    outcome.status === "published" || outcome.status === "published_dry_run";

  await setStatus(item, outcome.status, {
    status: outcome.status,
    ...(succeeded
      ? {
          platform_post_id: `batch:${item.id}`,
          published_at: new Date().toISOString(),
          last_error: null,
        }
      : { last_error: outcome.message }),
  });

  if (succeeded) {
    await logInfo(`${item.channel}: ${outcome.message}`, {
      queueId: item.id,
      requestId: item.request_id,
    });
  } else {
    await logWarn(`${item.channel}: ${outcome.message}`, {
      queueId: item.id,
      requestId: item.request_id,
      detail: { sent, failed, uncertain, skipped },
    });
    await notifyPublishProblem(item.id, uncertain > 0 ? "uncertain" : "partial", outcome.message);
  }

  return { status: outcome.status, message: outcome.message };
}

async function upsertDelivery(
  item: PublishQueueItem,
  recipient: Recipient,
  fields: Record<string, unknown>,
): Promise<void> {
  await serviceClient()
    .from(table("publish_deliveries"))
    .upsert(
      {
        queue_id: item.id,
        recipient_id: recipient.id,
        channel: item.channel,
        ...fields,
      },
      { onConflict: "queue_id,recipient_id" },
    );
}

// ─── The watchdog (§15.5) ───────────────────────────────────────────────────

/**
 * Moves anything stuck in `publishing` to `uncertain`, then attempts to
 * reconcile by reading back from the provider.
 *
 * "An automated system that cannot tell whether it did something must ask, not
 * guess." Found means it resolves; not found means a human decides.
 */
async function sweepStuck(): Promise<number> {
  const db = serviceClient();

  const { data: stuck } = await db.rpc("sweep_stuck_publishing", {
    p_minutes: PUBLISH_STUCK_MINUTES,
  });

  const rows = (stuck ?? []) as unknown as PublishQueueItem[];

  for (const item of rows) {
    const reconciled = await reconcile(item);

    if (!reconciled) {
      await notifyPublishProblem(
        item.id,
        "uncertain",
        "The send timed out and we cannot tell whether it went. It will NOT be retried " +
          "automatically — open the queue and tell us whether it sent.",
      );
    }
  }

  return rows.length;
}

/**
 * Reads back from the provider by message id. The newsletter can reconcile
 * automatically; a handoff cannot be uncertain, because nothing was sent by
 * the system (§15.5 table).
 */
async function reconcile(item: PublishQueueItem): Promise<boolean> {
  if (item.kind === "handoff") return false;

  const db = serviceClient();

  const { data: deliveries } = await db
    .from(table("publish_deliveries"))
    .select("id, provider_message_id, status")
    .eq("queue_id", item.id)
    .not("provider_message_id", "is", null);

  let confirmed = 0;

  for (const delivery of deliveries ?? []) {
    const status = await getEmailStatus(delivery.provider_message_id as string);
    if (status.found) {
      await db
        .from(table("publish_deliveries"))
        .update({ status: "delivered" })
        .eq("id", delivery.id as string);
      confirmed++;
    }
  }

  if (confirmed > 0 && confirmed === (deliveries ?? []).length) {
    await db
      .from(table("publish_queue"))
      .update({
        status: env.app.demoMode ? "published_dry_run" : "published",
        platform_post_id: `batch:${item.id}`,
        published_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", item.id);

    await logInfo("Reconciled an uncertain send: the provider confirms it went out.", {
      queueId: item.id,
      requestId: item.request_id,
    });
    return true;
  }

  return false;
}

async function markUncertain(item: PublishQueueItem, reason: string): Promise<void> {
  await setStatus(item, "uncertain", {
    status: "uncertain",
    last_error: `${reason} — the outcome is unknown, so this will not be retried automatically.`,
  });

  await logError(
    "A send failed in a way that leaves the outcome unknown. It will not be retried automatically.",
    { queueId: item.id, requestId: item.request_id, detail: { reason } },
  );

  await notifyPublishProblem(item.id, "uncertain", reason);
}

/**
 * §15.4: an item still awaiting a manual post two hours after its scheduled
 * time re-notifies ONCE, and then appears in the Failures strip. Scheduled
 * work that quietly never happened does not become acceptable because the last
 * step was a person's.
 */
async function remindOverdueHandoffs(): Promise<number> {
  const db = serviceClient();
  const cutoff = new Date(Date.now() - HANDOFF_REMINDER_HOURS * 3_600_000).toISOString();

  const { data: overdue } = await db
    .from(table("publish_queue"))
    .select("id, channel, request_id, scheduled_for")
    .eq("status", "awaiting_manual_post")
    .lt("scheduled_for", cutoff)
    .is("handoff_reminded_at", null);

  for (const item of overdue ?? []) {
    await notifyPublishProblem(
      item.id as string,
      "handoff_overdue",
      `This was scheduled for ${item.scheduled_for} and still has not been confirmed as posted.`,
    );
    await db
      .from(table("publish_queue"))
      .update({ handoff_reminded_at: new Date().toISOString() })
      .eq("id", item.id as string);
  }

  return (overdue ?? []).length;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loadConnector(channel: ChannelName) {
  const { data } = await serviceClient()
    .from(table("connectors"))
    .select("id, channel, kind, status, handoff_email, account_label")
    .eq("channel", channel)
    .maybeSingle();

  return data as unknown as
    | { status: ConnectorStatus; kind: string; handoff_email?: string | null }
    | null;
}

async function setStatus(
  item: PublishQueueItem,
  status: PublishStatus,
  fields: Record<string, unknown>,
): Promise<void> {
  const { error } = await serviceClient()
    .from(table("publish_queue"))
    .update({ ...fields, status })
    .eq("id", item.id);

  if (error) {
    await logWarn(`Could not record the ${status} outcome on a queue item.`, {
      queueId: item.id,
      detail: { error: error.message },
    });
  }
}
