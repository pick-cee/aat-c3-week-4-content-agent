"use server";

import { revalidatePath } from "next/cache";
import { serviceClient, table } from "@/lib/db/client";
import { verifyHandoffToken } from "@/lib/crypto";
import { logInfo } from "@/lib/log";
import { isValidUrl } from "@/lib/text";
import type { ActionResult } from "./requests";

/**
 * Confirming a handoff post. DESIGN.md §15.4.
 *
 * Authenticated by the signed token ALONE — the person posting is not
 * necessarily a user of this system, which is the whole point of a handoff.
 * So the token is scoped to one queue row and expires, and this action does
 * nothing that a stranger holding it could turn into a wider capability: it
 * can only mark one specific item as posted, with a URL.
 */

export async function confirmHandoff(
  token: string,
  platformUrl: string,
): Promise<ActionResult> {
  const verified = verifyHandoffToken(token);

  if (!verified.valid) {
    return {
      ok: false,
      error:
        verified.reason === "expired"
          ? "This link has expired. Ask for a fresh one from the queue."
          : "This link could not be verified.",
    };
  }

  const url = platformUrl.trim();
  if (!isValidUrl(url)) {
    return { ok: false, error: "That does not look like a valid link to the post." };
  }

  const db = serviceClient();

  const { data: item } = await db
    .from(table("publish_queue"))
    .select("id, status, channel, kind, request_id, platform_url")
    .eq("id", verified.payload.queueId)
    .maybeSingle();

  if (!item) return { ok: false, error: "This post is no longer scheduled." };

  // Opened twice: the second confirmation is a no-op that reports what is
  // already recorded, rather than creating a second record (§21.1).
  if (item.status === "posted_manually") {
    return { ok: true };
  }

  if (item.kind !== "handoff") {
    return { ok: false, error: "This channel is not posted by hand." };
  }

  // Only a person confirming with a URL makes it `posted_manually`, which
  // stays visibly distinct from `published` everywhere (§2.9). The check
  // constraint on the table enforces that a handoff can never be `published`.
  const { error } = await db
    .from(table("publish_queue"))
    .update({
      status: "posted_manually",
      platform_url: url,
      confirmed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", item.id)
    // Guard against two people confirming at once: only a row that has not
    // already been confirmed is updated.
    .neq("status", "posted_manually");

  if (error) return { ok: false, error: `Could not record it: ${error.message}` };

  await logInfo(
    `A person confirmed the ${item.channel} post is live. This is recorded as posted by hand, not as published by the system.`,
    { queueId: item.id, requestId: item.request_id as string, detail: { platformUrl: url } },
  );

  revalidatePath("/queue");
  return { ok: true };
}
