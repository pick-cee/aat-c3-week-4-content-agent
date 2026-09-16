"use server";

import { revalidatePath } from "next/cache";
import { serviceClient, currentProfile, canApprove, table } from "@/lib/db/client";
import { logInfo } from "@/lib/log";
import { isValidEmail } from "@/lib/text";
import type { ActionResult } from "./requests";

/**
 * Settings: the brand voice and the newsletter list.
 *
 * Both were read-only, which meant the voice that governs every generation
 * call — tone rules, banned phrases, emoji allowance — could only be changed
 * by editing the seed file, and the only newsletter recipients that existed
 * were the six demo rows seeded on first boot.
 *
 * Consent is the rule that shapes this file (rule 9c): a recipient is created
 * with an explicit opt-in source naming who added them and when, opting out is
 * immediate and permanent, and nothing here can manufacture consent that a
 * person did not give.
 */

// ─── Brand voice ────────────────────────────────────────────────────────────

export interface BrandVoiceInput {
  name: string;
  description: string;
  audienceDefault: string;
  toneRules: string[];
  bannedPhrases: string[];
  ctaDefault: string;
  readingLevel: string;
  emojiAllowance: number;
}

export async function updateBrandVoice(
  voiceId: string,
  input: BrandVoiceInput,
): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };
  if (!canApprove(profile)) {
    return { ok: false, error: "Only a reviewer or an admin can change the brand voice." };
  }

  const name = input.name.trim();
  if (!name) return { ok: false, error: "The voice needs a name." };

  // Blank lines are how an empty textarea arrives; they are not rules.
  const toneRules = input.toneRules.map((r) => r.trim()).filter(Boolean);
  const bannedPhrases = input.bannedPhrases.map((p) => p.trim()).filter(Boolean);

  const emoji = Number.isFinite(input.emojiAllowance)
    ? Math.max(0, Math.min(10, Math.round(input.emojiAllowance)))
    : 0;

  const db = serviceClient();
  const { error } = await db
    .from(table("brand_voices"))
    .update({
      name,
      description: input.description.trim() || null,
      audience_default: input.audienceDefault.trim() || null,
      tone_rules: toneRules,
      banned_phrases: bannedPhrases,
      cta_default: input.ctaDefault.trim() || null,
      reading_level: input.readingLevel.trim() || null,
      emoji_allowance: emoji,
    })
    .eq("id", voiceId);

  if (error) return { ok: false, error: `Could not save the voice: ${error.message}` };

  await logInfo(
    `Brand voice "${name}" updated: ${toneRules.length} tone rules, ` +
      `${bannedPhrases.length} banned phrases.`,
    { actorId: profile.id },
  );

  revalidatePath("/settings");
  return { ok: true };
}

// ─── Newsletter recipients ──────────────────────────────────────────────────

/**
 * Adds one or many addresses, one per line.
 *
 * Every address is validated before any is written, so a typo on line four
 * does not leave three rows created and no explanation. Duplicates are
 * reported rather than silently ignored, because "I added it and nothing
 * happened" is the confusing outcome.
 */
export async function addRecipients(raw: string): Promise<
  ActionResult<{ added: number; skipped: string[] }>
> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };
  if (!canApprove(profile)) {
    return { ok: false, error: "Only a reviewer or an admin can change the newsletter list." };
  }

  const entries = raw
    .split(/[\n,;]/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    return { ok: false, error: "Enter at least one email address." };
  }

  const invalid = entries.filter((e) => !isValidEmail(e));
  if (invalid.length > 0) {
    // Named, and with the row, rather than "some addresses were invalid".
    return {
      ok: false,
      error:
        invalid.length === 1
          ? `"${invalid[0]}" is not a valid email address, so nothing was added.`
          : `${invalid.length} addresses are not valid (${invalid
              .slice(0, 3)
              .join(", ")}${invalid.length > 3 ? "…" : ""}), so nothing was added.`,
    };
  }

  const db = serviceClient();
  const handles = [...new Set(entries.map((e) => e.toLowerCase()))];

  const { data: existingRows } = await db
    .from(table("recipients"))
    .select("handle")
    .eq("channel", "newsletter")
    .in("handle", handles);

  const existing = new Set((existingRows ?? []).map((r) => r.handle as string));
  const fresh = handles.filter((h) => !existing.has(h));

  if (fresh.length === 0) {
    return {
      ok: false,
      error:
        handles.length === 1
          ? "That address is already on the list."
          : "Every one of those addresses is already on the list.",
    };
  }

  const now = new Date().toISOString();
  const { error } = await db.from(table("recipients")).insert(
    fresh.map((handle) => ({
      channel: "newsletter" as const,
      handle,
      // Consent is recorded with its provenance: who added them and when
      // (rule 9c). "Added by a reviewer" is an honest source; it is not a
      // claim that the person filled in a form.
      opted_in_at: now,
      opt_in_source: `Added in settings by ${profile.email}`,
    })),
  );

  if (error) return { ok: false, error: `Could not add them: ${error.message}` };

  await logInfo(
    `${fresh.length} newsletter recipient${fresh.length === 1 ? "" : "s"} added.`,
    { actorId: profile.id },
  );

  revalidatePath("/settings");
  return { ok: true, data: { added: fresh.length, skipped: [...existing] } };
}

/**
 * Puts an opted-out recipient back on the list.
 *
 * Opting out is permanent as a DEFAULT, not as a prison: someone unsubscribes
 * by mistake, or asks to be added back, and the only way to honour that was to
 * delete the row and re-add the address, which loses the history of what
 * happened.
 *
 * The consent record is rewritten with a new source naming who did it and
 * when, so "why is this person on the list again" has an answer. Nothing here
 * can be done by the recipient's own unsubscribe link, which stays one-way.
 */
export async function optInRecipient(recipientId: string): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };
  if (!canApprove(profile)) {
    return { ok: false, error: "Only a reviewer or an admin can change the newsletter list." };
  }

  const db = serviceClient();
  const now = new Date().toISOString();

  const { error } = await db
    .from(table("recipients"))
    .update({
      opt_out_at: null,
      opted_in_at: now,
      opt_in_source: `Re-subscribed in settings by ${profile.email}`,
    })
    .eq("id", recipientId);

  if (error) return { ok: false, error: `Could not re-subscribe them: ${error.message}` };

  await logInfo("A newsletter recipient was re-subscribed by a reviewer.", {
    actorId: profile.id,
  });

  revalidatePath("/settings");
  return { ok: true };
}

/**
 * Opting out is immediate and permanent (rule 9c).
 *
 * The row is kept rather than deleted: a deleted recipient could be re-added
 * by the next import and would start receiving mail again, which is the one
 * thing an opt-out must prevent.
 */
export async function optOutRecipient(recipientId: string): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };
  if (!canApprove(profile)) {
    return { ok: false, error: "Only a reviewer or an admin can change the newsletter list." };
  }

  const db = serviceClient();
  const { error } = await db
    .from(table("recipients"))
    .update({ opt_out_at: new Date().toISOString() })
    .eq("id", recipientId)
    .is("opt_out_at", null);

  if (error) return { ok: false, error: `Could not opt them out: ${error.message}` };

  await logInfo("A newsletter recipient was opted out.", { actorId: profile.id });
  revalidatePath("/settings");
  return { ok: true };
}
