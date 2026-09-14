import "server-only";
import { serviceClient, table } from "./client";
import { env } from "@/lib/env";
import { ALL_CHANNELS, CHANNEL_DEFAULT_KIND } from "@/lib/constants";
import type { ConnectorStatus } from "./types";
import { DEMO_ACCOUNT } from "@/lib/personas";

/**
 * Idempotent seed, run at startup after migrations.
 *
 * Seeds only what the system cannot function without: one brand voice (the
 * rubric's Tone criterion is judged against it, so without a stored voice
 * "tone matches the brand" is unfalsifiable — §5.2), and one connector row per
 * channel (a connector's absence is a state the publish worker reads, so the
 * row must exist saying `not_connected` rather than be missing — §15.1).
 *
 * Demo recipients are seeded only in DEMO_MODE, and only to addresses and
 * numbers we control (§19.7).
 */

const DEFAULT_VOICE = {
  name: "Koya Talent — house voice",
  description:
    "Direct, evidence-led writing for an African talent and marketing audience. " +
    "Plain sentences, concrete examples, no hype.",
  audience_default: "Founders and hiring leads at growing African companies",
  tone_rules: [
    "Lead with the point. No throat-clearing openers.",
    "Prefer concrete nouns and real numbers over adjectives.",
    "Short paragraphs, two to three sentences.",
    "Address the reader as 'you'. Never 'one' or 'we the reader'.",
    "Explain a term the first time it appears, then use it plainly.",
    "No exclamation marks outside a direct quotation.",
    "Claims carry evidence. If there is no source for it, do not assert it.",
  ],
  // Computed as well as judged: a banned phrase is a hard failure in code, not
  // an opinion the evaluator might forgive (§11.1, §11.2).
  banned_phrases: [
    "game-changer",
    "game changer",
    "revolutionary",
    "cutting-edge",
    "in today's fast-paced world",
    "unlock the power",
    "take it to the next level",
    "synergy",
    "leverage our",
    "seamlessly",
    "delve into",
    "in conclusion",
    "it is important to note",
  ],
  cta_default: "Read the full breakdown",
  reading_level: "Plain English, roughly Grade 9. Technical where the topic demands it.",
  emoji_allowance: 3,
  is_default: true,
};


export async function seedIfEmpty(): Promise<void> {
  try {
    const db = serviceClient();

    await seedDemoAccounts(db);
    await seedBrandVoice(db);
    await seedConnectors(db);
    if (env.app.demoMode) await seedDemoRecipients(db);
  } catch (err) {
    // Never block startup. A seed failure shows up at /api/health.
    console.error("[seed] failed:", err);
  }
}

/**
 * Creates the auth users and their profile rows.
 *
 * Created through the ADMIN API rather than `signUp`: signUp sends a
 * confirmation email, which fails with "email rate limit exceeded" on
 * Supabase's built-in SMTP and would leave the account unconfirmed and unable
 * to sign in. `email_confirm: true` sidesteps both — there is no inbox to
 * confirm from, by design.
 */
async function seedDemoAccounts(db: ReturnType<typeof serviceClient>) {
  const account = DEMO_ACCOUNT;

  const { data: created, error } = await db.auth.admin.createUser({
    email: account.email,
    password: account.password,
    email_confirm: true,
    user_metadata: { full_name: account.fullName },
  });

  let userId: string | undefined = created?.user?.id;

  if (!userId && error) {
    if (/already|registered|exists/i.test(error.message)) {
      // Already there from a previous boot. Find it rather than give up.
      const { data: list } = await db.auth.admin.listUsers();
      userId = list?.users.find((u) => u.email === account.email)?.id;
    } else {
      console.error(`[seed] could not create ${account.email}: ${error.message}`);
      return;
    }
  }

  if (!userId) return;

  // Re-asserted on every boot, so changing the role in personas.ts takes
  // effect rather than being frozen at whatever the first run wrote.
  const { error: profileError } = await db.from(table("profiles")).upsert(
    {
      id: userId,
      email: account.email,
      full_name: account.fullName,
      role: account.role,
      is_demo: true,
    },
    { onConflict: "id" },
  );

  if (profileError) {
    console.error(`[seed] could not write profile: ${profileError.message}`);
  }
}

async function seedBrandVoice(db: ReturnType<typeof serviceClient>) {
  const { data: existing } = await db
    .from(table("brand_voices"))
    .select("id")
    .eq("is_default", true)
    .maybeSingle();

  if (existing) return;

  const { error } = await db.from(table("brand_voices")).insert(DEFAULT_VOICE);
  if (error && !error.message.includes("duplicate")) {
    console.error("[seed] brand voice:", error.message);
  }
}

/**
 * One row per channel. The worker branches on `kind`, never on a channel name
 * (§5.13) — so if LinkedIn access is ever obtained, that channel becomes
 * `delivering` by changing this one row and no publishing code changes.
 */
async function seedConnectors(db: ReturnType<typeof serviceClient>) {
  const { data: existing } = await db.from(table("connectors")).select("channel");
  const have = new Set((existing ?? []).map((r) => r.channel as string));

  const missing = ALL_CHANNELS.filter((c) => !have.has(c)).map((channel) => ({
    channel,
    kind: CHANNEL_DEFAULT_KIND[channel],
    // Honest default. A connector that was never configured is `not_connected`,
    // which puts its queued items into `blocked_not_connected` with a reason
    // rather than failing them or faking a success (§15.1).
    status: connectorStatusFor(channel),
    account_label: accountLabelFor(channel),
    handoff_email: CHANNEL_DEFAULT_KIND[channel] === "handoff"
      ? env.app.handoffPosterEmail || null
      : null,
  }));

  if (missing.length === 0) return;

  const { error } = await db.from(table("connectors")).insert(missing);
  if (error && !error.message.includes("duplicate")) {
    console.error("[seed] connectors:", error.message);
  }
}

function connectorStatusFor(channel: string): ConnectorStatus {
  // A handoff channel is "connected" when there is somewhere to send the
  // packet. A delivering channel is connected when its credentials exist.
  if (channel === "newsletter") return env.resend.configured ? "connected" : "not_connected";
  return env.app.handoffPosterEmail ? "connected" : "not_connected";
}

function accountLabelFor(channel: string): string | null {
  if (channel === "newsletter") return env.resend.configured ? env.resend.from : null;
  return env.app.handoffPosterEmail ? `Handoff to ${env.app.handoffPosterEmail}` : null;
}

/**
 * Demo recipients, DEMO_MODE only. Deliberately includes one opted-out and one
 * never-opted-in row, because the broken-input pack (§21.1) needs a recipient
 * that must be skipped and counted as `skipped_no_optin` rather than silently
 * dropped — and a seed of forty happy rows would never exercise it.
 */
async function seedDemoRecipients(db: ReturnType<typeof serviceClient>) {
  const { count } = await db
    .from(table("recipients"))
    .select("id", { count: "exact", head: true });

  if ((count ?? 0) > 0) return;

  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];

  // Newsletter: addresses we control.
  const demoEmail = env.app.demoRedirectEmail || env.resend.replyTo;
  if (demoEmail) {
    rows.push({
      channel: "newsletter",
      handle: demoEmail,
      display_name: "Demo inbox",
      opted_in_at: now,
      opt_in_source: "seed:demo",
    });
  }
  rows.push(
    {
      channel: "newsletter",
      handle: "opted.out@koya-demo.invalid",
      display_name: "Opted-out subscriber",
      opted_in_at: now,
      opt_in_source: "seed:demo",
      // Skipped at SEND time, not at approval time (§21.1).
      opt_out_at: now,
    },
    {
      channel: "newsletter",
      handle: "never.opted.in@koya-demo.invalid",
      display_name: "Never opted in",
      // No opted_in_at → `skipped_no_optin`, counted and shown, never messaged.
      opt_in_source: "seed:demo",
    },
  );

  // A handful of opted-in addresses on a domain we control, so a broadcast
  // has a real fan-out to demonstrate partial delivery against (§21.1).
  for (let i = 1; i <= 3; i++) {
    rows.push({
      channel: "newsletter",
      handle: `subscriber${i}@koya-demo.invalid`,
      display_name: `Demo subscriber ${i}`,
      opted_in_at: now,
      opt_in_source: "seed:demo",
    });
  }

  const { error } = await db.from(table("recipients")).insert(rows);
  if (error && !error.message.includes("duplicate")) {
    console.error("[seed] recipients:", error.message);
  }
}
