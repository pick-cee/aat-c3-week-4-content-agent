"use server";

import { countWords, parseHeadings } from "@/lib/text";
import { kickoffPipeline } from "@/lib/pipeline/kickoff";
import { checkMarkerIntegrity } from "@/lib/pipeline/grounding";
import { isArticleLocked } from "@/lib/pipeline/review-locks";
import { replaceEmDashes } from "@/lib/pipeline/checks";
import { revalidatePath } from "next/cache";
import { serviceClient, currentProfile, canApprove, table } from "@/lib/db/client";
import { logInfo, logWarn } from "@/lib/log";
import { buildClaimMap, labelExcerpts } from "@/lib/pipeline/grounding";
import { saveVersion } from "@/lib/pipeline/drafting";
import { findImageCandidates, storeChosenImage } from "@/lib/pipeline/images";
import { CHANNEL_DEFAULT_KIND } from "@/lib/constants";
import type {
  ArticleVersion,
  ChannelName,
  ChannelOutput,
  ContentRequest,
  ImageCandidate,
  PublishQueueItem,
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
export async function approveChannel(requestId: string, channelOutputId: string,
  scheduledFor: string | null, note?: string): Promise<ActionResult<{ queued: boolean; scheduledFor: string }>> {
  const profile = await currentProfile();
  if (!canApprove(profile) || !profile) return { ok: false, error: "A reviewer or admin must approve content." };
  if (scheduledFor && !Number.isFinite(Date.parse(scheduledFor))) return { ok: false, error: "Choose a valid publication time." };
  const { data, error } = await serviceClient().rpc("approve_content_channel", {
    p_request_id: requestId, p_output_id: channelOutputId, p_actor_id: profile.id,
    p_scheduled_for: scheduledFor, p_note: note?.trim() || null,
  });
  if (error || !data?.[0]) return { ok: false, error: error?.message ?? "Approval was not saved." };
  await logInfo(data[0].scheduled_for ? "Content approved and scheduled." : "Content approved and held in the queue.", { requestId, actorId: profile.id });
  revalidatePath("/"); revalidatePath("/requests/" + requestId); revalidatePath("/queue");
  return { ok: true, data: { queued: true, scheduledFor: data[0].scheduled_for ?? "" } };
}

/**
 * Approves several channels in one action.
 *
 * Channels are still approved INDEPENDENTLY — this calls the same single
 * channel path for each, so every guarantee holds per channel: its own
 * approval row, its own queue row, its own NOT NULL columns. What changes is
 * only the number of clicks.
 *
 * A reviewer who has read the article and wants it on all three channels was
 * previously made to approve them one at a time, each with its own scheduling
 * decision. That is three times the work for the ordinary case.
 *
 * Partial success is reported honestly rather than rolled back: if LinkedIn
 * queues and X fails its format rules, the LinkedIn approval is real and
 * saying otherwise would be a lie. The result names what happened to each.
 */
export async function approveChannels(
  requestId: string,
  channelOutputIds: string[],
  scheduledFor: string | null,
  note?: string,
): Promise<ActionResult<{ approved: string[]; failed: { id: string; error: string }[] }>> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };
  if (!canApprove(profile)) {
    return { ok: false, error: "Only a reviewer or an admin can approve content for publishing." };
  }

  if (channelOutputIds.length === 0) {
    return { ok: false, error: "Pick at least one channel to approve." };
  }

  const approved: string[] = [];
  const failed: { id: string; error: string }[] = [];

  // Sequential, not Promise.all: each approval writes to the same request row
  // (moveToScheduled) and the same queue table, and the per-channel unique
  // index is what keeps a double-approve honest. Three round trips is not
  // worth racing.
  for (const id of channelOutputIds) {
    const result = await approveChannel(requestId, id, scheduledFor, note);
    if (result.ok) approved.push(id);
    else failed.push({ id, error: result.error ?? "That did not work." });
  }

  revalidatePath(`/requests/${requestId}`);
  revalidatePath("/queue");

  if (approved.length === 0) {
    return {
      ok: false,
      error:
        failed.length === 1
          ? failed[0]!.error
          : `None of the ${failed.length} channels could be approved. ${failed[0]!.error}`,
    };
  }

  return { ok: true, data: { approved, failed } };
}

export async function rejectChannel(requestId: string, channelOutputId: string, note: string): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile || !canApprove(profile)) return { ok: false, error: "A reviewer must reject content." };
  const { error } = await serviceClient().rpc("reject_content_channel", { p_request_id: requestId, p_output_id: channelOutputId, p_actor_id: profile.id, p_note: note });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/requests/" + requestId); revalidatePath("/queue");
  return { ok: true };
}

export async function requestRevision(requestId: string, note: string): Promise<ActionResult> {
  return reviewArticle(requestId, "revision_requested", note);
}

export async function requestChannelRevision(requestId: string, outputId: string, note: string): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile || !canApprove(profile)) return { ok: false, error: "A reviewer or admin must request this revision." };
  if (!note.trim() || note.trim().length > 2000) return { ok: false, error: "Describe the change in 1 to 2,000 characters." };
  const { error } = await serviceClient().rpc("request_channel_revision", {
    p_request_id: requestId, p_output_id: outputId, p_actor_id: profile.id, p_note: note.trim(),
  });
  if (error) return { ok: false, error: error.message };
  kickoffPipeline(requestId);
  revalidatePath("/requests/" + requestId); revalidatePath("/queue"); revalidatePath("/");
  return { ok: true };
}

export async function acceptDespiteChecks(requestId: string, note: string): Promise<ActionResult> {
  return reviewArticle(requestId, "approved", note);
}
async function reviewArticle(requestId: string, decision: string, note: string): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "Sign in to review content." };
  const { error } = await serviceClient().rpc("review_content_article", { p_request_id: requestId, p_actor_id: profile.id, p_decision: decision, p_note: note });
  if (error) return { ok: false, error: error.message };
  await logInfo(decision === "approved" ? "A reviewer accepted this draft with a recorded override." : "A revision was requested.", { requestId, actorId: profile.id });
  kickoffPipeline(requestId);
  revalidatePath("/requests/" + requestId);
  return { ok: true };
}

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

  if (!excerptRows || excerptRows.length !== current.excerpt_ids_used.length || !sourceRows) return { ok: false, error: "The source ledger could not be loaded. No edit was saved." };

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

  const cleaned = replaceEmDashes(body.trim());
  if (!cleaned || cleaned.length > 80_000) return { ok: false, error: "Use between 1 and 80,000 characters." };
  if (!checkMarkerIntegrity(cleaned, excerpts).valid) return { ok: false, error: "The edit cites an excerpt that does not exist." };
  const { data: versionId, error } = await db.rpc("save_content_edit", {
    p_request_id: requestId, p_parent_id: current.id, p_body: cleaned,
    p_title: replaceEmDashes(title?.trim() || parseHeadings(cleaned).find(h => h.level === 1)?.text || current.title),
    p_headings: parseHeadings(cleaned).map(h=>({ level: h.level, text: h.text })), p_word_count: countWords(cleaned),
  });
  if (error) return { ok: false, error: error.message };
  await logInfo("Article edit saved. Checking the new version and rebuilding its channel content.", { requestId, actorId: profile.id });
  kickoffPipeline(requestId);
  revalidatePath("/requests/" + requestId);
  return { ok: true, data: { versionId, flagged: 0 } };
}


export async function findImages(requestId: string): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "Sign in to find an image." };
  const db = serviceClient();
  const { data: request } = await db.from(table("content_requests")).select("*").eq("id",requestId).is("deleted_at",null).maybeSingle();
  if (!request || isArticleLocked(request.status)) return { ok: false, error: "This article is locked." };
  const { data: version } = await db.from(table("article_versions")).select("*").eq("request_id",requestId).order("version",{ascending:false}).limit(1).maybeSingle();
  if (!version) return { ok: false, error: "Write the article before choosing an image." };
  const candidates = await findImageCandidates(request as unknown as ContentRequest, version as unknown as ArticleVersion);
  revalidatePath("/requests/" + requestId);
  return candidates.length ? { ok: true } : { ok: false, error: "No suitable images were found. You can publish without an image or search again later." };
}

export async function chooseImage(requestId: string, imageId: string | null, altText?: string): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "Sign in to choose an image." };
  const db = serviceClient();
  const { error } = await db.rpc("choose_content_image", { p_request_id: requestId, p_image_id: imageId, p_alt: altText?.trim() ?? null });
  if (error) return { ok: false, error: error.message };
  if (imageId) {
    const { data: image } = await db.from(table("images")).select("*").eq("id",imageId).eq("request_id",requestId).single();
    if (image) await storeChosenImage(image as unknown as ImageCandidate);
  }
  revalidatePath("/requests/" + requestId);
  return { ok: true };
}

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
  // `held` is the whole point of this list: giving a held item a time is how
  // it stops being held. Omitting it would leave approved work permanently
  // stuck, visible and unsendable.
  if (!["queued", "held", "blocked_not_connected", "failed"].includes(item.status as string)) {
    return {
      ok: false,
      error: `An item that is ${item.status} cannot be rescheduled.`,
    };
  }

  if (!Number.isFinite(Date.parse(scheduledFor))) return { ok: false, error: "Choose a valid date and time." };
  const { data: changed, error } = await db.from(table("publish_queue"))
    .update({ scheduled_for: scheduledFor, status: "queued", last_error: null })
    .eq("id", queueId).in("status", ["queued", "held", "blocked_not_connected", "failed"]).select("id").maybeSingle();
  if (error || !changed) return { ok: false, error: error?.message ?? "This item changed. Refresh to see its current status." };

  revalidatePath("/queue");
  return { ok: true };
}

export async function cancelQueueItem(queueId: string): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };
  if (!canApprove(profile)) {
    return { ok: false, error: "Only a reviewer or an admin can cancel a queued item." };
  }

  // The error was discarded here and `ok: true` returned regardless, so a
  // rejected write reported success and the button did nothing visible. An
  // action that cannot fail is an action that cannot be trusted.
  const { data: changed, error } = await serviceClient()
    .from(table("publish_queue"))
    .update({ status: "cancelled" })
    .eq("id", queueId).in("status", ["queued", "held", "blocked_not_connected", "failed", "awaiting_manual_post"]).select("id").maybeSingle();
  if (!changed && !error) return { ok: false, error: "Only a pending delivery can be cancelled. Refresh this item." };

  if (error) return { ok: false, error: `Could not cancel it: ${error.message}` };

  await logInfo("A queued item was cancelled.", { queueId, actorId: profile.id });

  // Cancelling the last outstanding channel settles the request, exactly as a
  // send does. Without this a request whose every channel was cancelled sat at
  // "Scheduled" with nothing left to schedule.
  const { data: row } = await serviceClient()
    .from(table("publish_queue"))
    .select("request_id")
    .eq("id", queueId)
    .maybeSingle();

  if (row?.request_id) {
    const { settleRequestIfDone } = await import("@/lib/publish/worker");
    await settleRequestIfDone(row.request_id as string);
  }

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

  const cleanUrl = platformUrl?.trim() || null;
  if (cleanUrl) {
    try { const parsed = new URL(cleanUrl); if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error(); }
    catch { return { ok: false, error: 'Enter a valid public post URL.' }; }
  }
  if (itSent && item.kind === 'handoff' && !cleanUrl) return { ok: false, error: 'Confirming a manual post needs its URL.' };
  const now = new Date().toISOString();
  const patch: Partial<PublishQueueItem> = !itSent ? { status: 'queued', last_error: 'A person confirmed this did not send. Re-queued.' }
    : item.kind === 'handoff' ? { status: 'posted_manually', platform_url: cleanUrl, confirmed_by: profile.id, confirmed_at: now, last_error: null }
    : { status: 'published', platform_post_id: 'human-confirmed:' + queueId, platform_url: cleanUrl, published_at: now, confirmed_by: profile.id, confirmed_at: now, last_error: null };
  const { data: changed, error: saveError } = await db.from(table('publish_queue')).update(patch)
    .eq('id', queueId).eq('status', 'uncertain').select('request_id').maybeSingle();
  if (saveError || !changed) return { ok: false, error: saveError?.message ?? 'Someone already resolved this item. Refresh the queue.' };
  await logInfo(itSent ? 'A person confirmed that an uncertain send went out.' : 'A person confirmed that an uncertain send did not go out. Re-queued.', { queueId, actorId: profile.id });
  if (itSent) {
    const { settleRequestIfDone } = await import('@/lib/publish/worker');
    await settleRequestIfDone(changed.request_id as string);
  }

  revalidatePath("/queue");
  return { ok: true };
}

export type { ChannelName };
