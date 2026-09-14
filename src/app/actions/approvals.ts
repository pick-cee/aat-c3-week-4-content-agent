"use server";

import { revalidatePath } from "next/cache";
import { serviceClient, currentProfile, canApprove, table } from "@/lib/db/client";
import { logInfo, logWarn } from "@/lib/log";
import { buildClaimMap, labelExcerpts } from "@/lib/pipeline/grounding";
import { saveVersion } from "@/lib/pipeline/drafting";
import { generateAltText, storeChosenImage } from "@/lib/pipeline/images";
import { CHANNEL_DEFAULT_KIND } from "@/lib/constants";
import type {
  ArticleVersion,
  ChannelName,
  ChannelOutput,
  ContentRequest,
  ImageCandidate,
} from "@/lib/db/types";
import type { ActionResult } from "./requests";

/**
 * Gate two: approval, scheduling and human edits. DESIGN.md §14.2, §14.3.
 *
 * This file is enforcement point 1 of the three that make publishing before
 * approval impossible: **publish_queue rows are created ONLY by the approval
 * action**. Point 2 is the worker re-checking approval; point 3 is the NOT
 * NULL columns on the queue row, which survive a refactor of the other two.
 */

// ─── Approving a channel (§14.2) ────────────────────────────────────────────

/**
 * Channels are approved independently, so one weak LinkedIn post does not hold
 * up a newsletter that is ready.
 */
export async function approveChannel(
  requestId: string,
  channelOutputId: string,
  scheduledFor: string | null,
  note?: string,
): Promise<ActionResult<{ queued: boolean; scheduledFor: string }>> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };

  // Approval is a reviewer/admin action, checked server-side (§4).
  if (!canApprove(profile)) {
    return {
      ok: false,
      error: "Only a reviewer or an admin can approve content for publishing.",
    };
  }

  const db = serviceClient();

  const { data: outputRow } = await db
    .from(table("channel_outputs"))
    .select("*")
    .eq("id", channelOutputId)
    .eq("request_id", requestId)
    .maybeSingle();

  const output = outputRow as unknown as ChannelOutput | null;
  if (!output) return { ok: false, error: "That channel output no longer exists." };

  if (output.status === "approved") {
    return { ok: false, error: "That channel is already approved." };
  }

  // A channel that failed its format checks can still be approved, but the
  // person doing it should be making that choice knowingly rather than by
  // clicking past a warning they never saw.
  if (output.status === "format_failed" && !note) {
    return {
      ok: false,
      error:
        "This channel did not meet its format rules. Approving it anyway needs a note saying why.",
    };
  }

  const approvedAt = new Date().toISOString();

  // The approval row comes first: the queue row's NOT NULL approved_by has to
  // point at a real decision, and this is that decision.
  const { error: approvalError } = await db.from(table("approvals")).insert({
    request_id: requestId,
    subject_type: "channel_output",
    subject_id: channelOutputId,
    actor_id: profile.id,
    decision: "approved",
    note: note ?? null,
  });

  if (approvalError) {
    return { ok: false, error: `Could not record the approval: ${approvalError.message}` };
  }

  const { error: statusError } = await db
    .from(table("channel_outputs"))
    .update({ status: "approved" })
    .eq("id", channelOutputId);

  if (statusError) {
    return { ok: false, error: `Could not mark the channel approved: ${statusError.message}` };
  }

  const { data: requestRow } = await db
    .from(table("content_requests"))
    .select("*")
    .eq("id", requestId)
    .single();

  const request = requestRow as unknown as ContentRequest;

  // "Hold in queue" means approved but not scheduled: a real state, and the
  // honest one when nobody has decided when it goes out.
  const when =
    scheduledFor ?? request.publish_target ?? (request.hold_in_queue ? null : new Date().toISOString());

  if (!when) {
    await logInfo(`${output.channel} approved and held in the queue with no send time.`, {
      requestId,
      actorId: profile.id,
    });
    await moveToScheduled(requestId);
    revalidatePath(`/requests/${requestId}`);
    return { ok: true, data: { queued: false, scheduledFor: "" } };
  }

  const kind = CHANNEL_DEFAULT_KIND[output.channel as keyof typeof CHANNEL_DEFAULT_KIND];

  const { error: queueError } = await db.from(table("publish_queue")).insert({
    request_id: requestId,
    channel_output_id: channelOutputId,
    channel: output.channel,
    kind,
    scheduled_for: when,
    status: "queued",
    // Both NOT NULL: a queue row cannot exist without an approval to point at.
    approved_by: profile.id,
    approved_at: approvedAt,
    idempotency_key: `${channelOutputId}:${output.channel}`,
  });

  if (queueError) {
    // The partial unique index doing its job — one live intent per output.
    if (queueError.message.includes("duplicate")) {
      return { ok: false, error: "That channel is already in the publishing queue." };
    }
    return { ok: false, error: `Could not queue the item: ${queueError.message}` };
  }

  await moveToScheduled(requestId);

  await logInfo(
    `${output.channel} approved and scheduled for ${new Date(when).toLocaleString("en-GB")}.` +
      (kind === "handoff"
        ? " It will be sent to whoever posts it; it is not published until they confirm."
        : ""),
    { requestId, actorId: profile.id },
  );

  revalidatePath(`/requests/${requestId}`);
  revalidatePath("/queue");
  return { ok: true, data: { queued: true, scheduledFor: when } };
}

async function moveToScheduled(requestId: string): Promise<void> {
  const db = serviceClient();
  const { data } = await db
    .from(table("content_requests"))
    .select("status")
    .eq("id", requestId)
    .maybeSingle();

  if (data?.status === "content_review") {
    await db
      .from(table("content_requests"))
      .update({ status: "scheduled", current_step: null })
      .eq("id", requestId);
  }
}

export async function rejectChannel(
  requestId: string,
  channelOutputId: string,
  note: string,
): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };
  if (!canApprove(profile)) {
    return { ok: false, error: "Only a reviewer or an admin can reject content." };
  }

  const db = serviceClient();

  await db.from(table("approvals")).insert({
    request_id: requestId,
    subject_type: "channel_output",
    subject_id: channelOutputId,
    actor_id: profile.id,
    decision: "rejected",
    note,
  });

  await db.from(table("channel_outputs")).update({ status: "rejected" }).eq("id", channelOutputId);

  // A rejected channel must not remain queued from an earlier approval.
  await db
    .from(table("publish_queue"))
    .update({ status: "cancelled" })
    .eq("channel_output_id", channelOutputId)
    .in("status", ["queued", "blocked_not_connected"]);

  await logInfo(`A channel was rejected: ${note}`, { requestId, actorId: profile.id });

  revalidatePath(`/requests/${requestId}`);
  return { ok: true };
}

/** Sends the whole request back for another revision round (§14.2). */
export async function requestRevision(
  requestId: string,
  note: string,
): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };
  if (!note.trim()) {
    return { ok: false, error: "Say what needs to change — a revision with no note is a guess." };
  }

  const db = serviceClient();

  const { data: version } = await db
    .from(table("article_versions"))
    .select("id")
    .eq("request_id", requestId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  await db.from(table("approvals")).insert({
    request_id: requestId,
    subject_type: "article",
    subject_id: (version?.id as string) ?? requestId,
    actor_id: profile.id,
    decision: "revision_requested",
    note,
  });

  await db
    .from(table("content_requests"))
    .update({ status: "revising", current_step: "revise", step_attempts: 0 })
    .eq("id", requestId);

  await logInfo(`Revision requested: ${note}`, {
    requestId,
    step: "revise",
    actorId: profile.id,
  });

  revalidatePath(`/requests/${requestId}`);
  return { ok: true };
}

// ─── Human edits (§11.4) ────────────────────────────────────────────────────

/**
 * A human edit creates a version with origin = 'human_edit' and RE-RUNS the
 * computed checks, including grounding.
 *
 * "A human is allowed to add an unmarked factual sentence; the system flags it
 * and shows the flag, and the reviewer can accept it explicitly. The check does
 * not become optional because a person did the typing."
 */
export async function saveHumanEdit(
  requestId: string,
  body: string,
  title?: string,
): Promise<ActionResult<{ versionId: string; flagged: number }>> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };

  const db = serviceClient();

  const { data: requestRow } = await db
    .from(table("content_requests"))
    .select("*")
    .eq("id", requestId)
    .single();

  const request = requestRow as unknown as ContentRequest | null;
  if (!request) return { ok: false, error: "That request no longer exists." };

  const { data: currentRow } = await db
    .from(table("article_versions"))
    .select("*")
    .eq("request_id", requestId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const current = currentRow as unknown as ArticleVersion | null;
  if (!current) return { ok: false, error: "There is no article to edit." };

  // Rebuild the exact labelled excerpt set the draft used, so markers in the
  // edited body still resolve to the same excerpts.
  const { data: excerptRows } = await db
    .from(table("excerpts"))
    .select("id, source_id, text, heading_path, embedding")
    .in("id", current.excerpt_ids_used);

  const { data: sourceRows } = await db
    .from(table("sources"))
    .select("id, title, url, site_name, published_at")
    .eq("request_id", requestId);

  const sourceMap = new Map(
    (sourceRows ?? []).map((s) => [
      s.id as string,
      {
        title: s.title as string | null,
        url: s.url as string,
        site_name: s.site_name as string | null,
        published_at: s.published_at as string | null,
      },
    ]),
  );

  const byId = new Map((excerptRows ?? []).map((r) => [r.id as string, r]));
  const ordered = current.excerpt_ids_used
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r));

  const excerpts = labelExcerpts(
    ordered.map((r) => ({
      id: r.id as string,
      source_id: r.source_id as string,
      text: r.text as string,
      heading_path: r.heading_path as string | null,
      embedding: r.embedding,
    })),
    sourceMap,
  );

  const claim = await buildClaimMap({
    body,
    excerpts,
    requestId,
    step: "human_edit",
  });

  const { data: angle } = await db
    .from(table("angles"))
    .select("*")
    .eq("request_id", requestId)
    .eq("chosen", true)
    .maybeSingle();

  const version = await saveVersion({
    request,
    angle: angle as never,
    title: title?.trim() || current.title,
    metaDescription: current.meta_description,
    body,
    primaryKeyword: current.primary_keyword ?? "",
    secondaryKeywords: current.secondary_keywords ?? [],
    claimMap: claim.claimMap,
    linkTargets: current.link_targets,
    excerptIds: current.excerpt_ids_used,
    origin: "human_edit",
    parentVersionId: current.id,
  });

  const flagged = claim.unsupported.length + claim.tripwireHits.length;

  if (flagged > 0) {
    await logWarn(
      `The edited article has ${flagged} claim(s) with no supporting citation. They are flagged for you to accept or fix.`,
      { requestId, step: "human_edit", actorId: profile.id },
    );
  } else {
    await logInfo("Article edited by hand; all claims still check out.", {
      requestId,
      step: "human_edit",
      actorId: profile.id,
    });
  }

  revalidatePath(`/requests/${requestId}`);
  return { ok: true, data: { versionId: version.id, flagged } };
}

// ─── Images (§13) ───────────────────────────────────────────────────────────

export async function chooseImage(
  requestId: string,
  imageId: string | null,
): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };

  const db = serviceClient();

  // "or none" is a real choice (§13).
  await db.from(table("images")).update({ chosen: false }).eq("request_id", requestId);

  if (!imageId) {
    revalidatePath(`/requests/${requestId}`);
    return { ok: true };
  }

  const { data: imageRow } = await db
    .from(table("images"))
    .select("*")
    .eq("id", imageId)
    .eq("request_id", requestId)
    .maybeSingle();

  const image = imageRow as unknown as ImageCandidate | null;
  if (!image) return { ok: false, error: "That image no longer exists." };

  await db.from(table("images")).update({ chosen: true }).eq("id", imageId);

  const { data: version } = await db
    .from(table("article_versions"))
    .select("*")
    .eq("request_id", requestId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (version && !image.alt_text) {
    const altText = await generateAltText(
      { id: requestId } as ContentRequest,
      version as unknown as ArticleVersion,
      image,
    );
    await db.from(table("images")).update({ alt_text: altText }).eq("id", imageId);
  }

  // Downloaded so published content does not depend on a hotlink (§13).
  await storeChosenImage(image);

  revalidatePath(`/requests/${requestId}`);
  return { ok: true };
}

// ─── Queue actions ──────────────────────────────────────────────────────────

export async function rescheduleItem(
  queueId: string,
  scheduledFor: string,
): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };
  if (!canApprove(profile)) {
    return { ok: false, error: "Only a reviewer or an admin can reschedule." };
  }

  const db = serviceClient();

  const { data: item } = await db
    .from(table("publish_queue"))
    .select("status")
    .eq("id", queueId)
    .maybeSingle();

  if (!item) return { ok: false, error: "That queue item no longer exists." };

  // Rescheduling something already sent or in flight would be meaningless at
  // best and misleading at worst.
  if (!["queued", "blocked_not_connected", "failed"].includes(item.status as string)) {
    return {
      ok: false,
      error: `An item that is ${item.status} cannot be rescheduled.`,
    };
  }

  await db
    .from(table("publish_queue"))
    .update({ scheduled_for: scheduledFor, status: "queued", last_error: null })
    .eq("id", queueId);

  revalidatePath("/queue");
  return { ok: true };
}

export async function cancelQueueItem(queueId: string): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };
  if (!canApprove(profile)) {
    return { ok: false, error: "Only a reviewer or an admin can cancel a queued item." };
  }

  await serviceClient()
    .from(table("publish_queue"))
    .update({ status: "cancelled" })
    .eq("id", queueId);

  revalidatePath("/queue");
  return { ok: true };
}

/**
 * Resolves an `uncertain` row. Only a person moves it (§15.5) — the system
 * does not guess, and it does not retry an unknown write.
 */
export async function resolveUncertain(
  queueId: string,
  itSent: boolean,
  platformUrl?: string,
): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };
  if (!canApprove(profile)) {
    return { ok: false, error: "Only a reviewer or an admin can resolve this." };
  }

  const db = serviceClient();

  const { data: item } = await db
    .from(table("publish_queue"))
    .select("status, kind, channel")
    .eq("id", queueId)
    .maybeSingle();

  if (!item) return { ok: false, error: "That queue item no longer exists." };
  if (item.status !== "uncertain") {
    return { ok: false, error: "That item is not in an uncertain state." };
  }

  if (itSent) {
    // A handoff can never be `published`; if a person says it went out, that
    // is `posted_manually`, and it needs the URL.
    if (item.kind === "handoff") {
      if (!platformUrl?.trim()) {
        return { ok: false, error: "Confirming a manual post needs the URL of the post." };
      }
      await db
        .from(table("publish_queue"))
        .update({
          status: "posted_manually",
          platform_url: platformUrl.trim(),
          confirmed_by: profile.id,
          confirmed_at: new Date().toISOString(),
          last_error: null,
        })
        .eq("id", queueId);
    } else {
      await db
        .from(table("publish_queue"))
        .update({
          status: "published",
          platform_post_id: `human-confirmed:${queueId}`,
          platform_url: platformUrl?.trim() || null,
          published_at: new Date().toISOString(),
          last_error: null,
        })
        .eq("id", queueId);
    }

    await logInfo("A person confirmed that an uncertain send did go out.", {
      queueId,
      actorId: profile.id,
    });
  } else {
    // It did not send, so it goes back to queued and may be retried safely.
    await db
      .from(table("publish_queue"))
      .update({
        status: "queued",
        last_error: "A person confirmed this did not send. Re-queued.",
      })
      .eq("id", queueId);

    await logInfo("A person confirmed that an uncertain send did not go out. Re-queued.", {
      queueId,
      actorId: profile.id,
    });
  }

  revalidatePath("/queue");
  return { ok: true };
}

export type { ChannelName };
