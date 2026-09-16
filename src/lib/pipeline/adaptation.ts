import "server-only";
import { serviceClient, table } from "@/lib/db/client";
import { logInfo, logWarn } from "@/lib/log";
import { callStructured, recordDiscarded } from "@/lib/providers/anthropic";
import { checkInheritedMarkers, stripMarkers } from "./grounding";
import { checkLinkedIn, checkNewsletter, checkX, replaceEmDashes } from "./checks";
import { brandVoiceBlock, channelRulesBlock, PUNCTUATION_BLOCK } from "./prompts";
import {
  MODELS,
  MAX_TOKENS,
  CHANNEL_LIMITS,
  CHANNEL_FORMAT_RETRIES,
} from "@/lib/constants";
import { countXCharacters, trimXPost } from "@/lib/text";
import { env } from "@/lib/env";
import type {
  ArticleVersion,
  BrandVoice,
  ChannelName,
  ChannelOutput,
  ClaimMapEntry,
  ContentRequest,
  FormatCheckResult,
} from "@/lib/db/types";

/**
 * Channel adaptation. DESIGN.md §12.
 *
 * Model: Haiku 4.5. Short outputs, explicit formatting rules, low judgment.
 *
 * The structural guarantee (§2.8, rule 4): input is the approved article, the
 * brand voice and the channel rules, and NOTHING ELSE. No excerpts, no web
 * access, no source corpus. "The adapter physically cannot introduce a claim
 * that is not in the article."
 *
 * Markers are inherited and checked against the article's claim map; anything
 * else is a hard failure and a retry.
 */

// ─── Schemas, one per channel ───────────────────────────────────────────────

export const LINKEDIN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["body", "cta", "problem", "agitation", "solution"],
  properties: {
    body: { type: "string", description: "The full post, including the CTA as its last block." },
    cta: { type: "string", description: "The call to action, exactly as it appears in the body." },
    problem: { type: "string", description: "The problem span, copied verbatim from the body." },
    agitation: { type: "string", description: "The agitation span, copied verbatim." },
    solution: { type: "string", description: "The solution span, copied verbatim." },
  },
} as const;

export const X_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["body", "hashtags", "coreIdea"],
  properties: {
    body: { type: "string", description: "The post, including hashtags and line breaks." },
    // No minItems/maxItems: structured outputs reject array length constraints.
    // The count is stated here and enforced by checkX (§12.1).
    hashtags: {
      type: "array",
      description: "One or two relevant hashtags. Never three.",
      items: { type: "string" },
    },
    coreIdea: { type: "string", description: "The single idea this post carries." },
  },
} as const;

export const NEWSLETTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body", "cta"],
  properties: {
    subject: { type: "string" },
    body: { type: "string", description: "Markdown. Includes subheadings and the sign-off." },
    cta: { type: "string" },
  },
} as const;

function schemaFor(channel: ChannelName) {
  switch (channel) {
    case "linkedin": return LINKEDIN_SCHEMA;
    case "x": return X_SCHEMA;
    case "newsletter": return NEWSLETTER_SCHEMA;
  }
}

interface AdapterOutput {
  body: string;
  cta?: string;
  subject?: string;
  hashtags?: string[];
  coreIdea?: string;
  problem?: string;
  agitation?: string;
  solution?: string;
}

// ─── Adaptation ─────────────────────────────────────────────────────────────

export interface AdaptResult {
  channel: ChannelName;
  output: ChannelOutput | null;
  formatCheck: FormatCheckResult;
  /** True when the channel gave up after its retry (§12.1). */
  formatFailed: boolean;
}

/**
 * Adapts one channel. One retry on a format failure, with the specific
 * violation and the actual measured value named.
 *
 * A second failure marks that channel `format_failed` and surfaces it at gate
 * two — the other channels still proceed. One broken channel never blocks the
 * others (§12.1).
 */
export async function adaptChannel(
  request: ContentRequest,
  version: ArticleVersion,
  voice: BrandVoice | null,
  channel: ChannelName,
  articleUrl: string | null,
): Promise<AdaptResult> {
  const context = {
    requestId: request.id,
    step: "adapt",
    purpose: `adapt for ${channel}`,
  };

  const claimMap = (version.claim_map ?? []) as ClaimMapEntry[];
  // X's link is optional and off by default — an X post that earns a click on
  // its own hook outperforms one that spends its first line asking for it
  // (§12.2).
  const includeLink = channel !== "x" && Boolean(articleUrl);

  const system = [
    {
      text:
        "You adapt a finished, approved article for one channel.\n\n" +
        "You have the article and nothing else. You have no web access and no source " +
        "material. Every claim you make must already be in the article, if the article " +
        "does not contain a fact, you cannot use it, and you must not reach for anything " +
        "you happen to know about the topic.\n\n" +
        "Keep the article's citation markers ([E12]) on any sentence you carry over that " +
        "makes a factual claim. They are stripped before anyone sees the post; they are how " +
        "we verify you did not invent anything.",
      cache: true,
    },
    { text: channelRulesBlock(channel, voice?.emoji_allowance ?? 3), cache: true },
    ...(voice ? [{ text: brandVoiceBlock(voice), cache: true }] : []),
    { text: PUNCTUATION_BLOCK, cache: true },
  ];

  const basePrompt = buildAdaptPrompt(request, version, channel, includeLink ? articleUrl : null);

  let attempt = 0;
  let retryNote = "";
  let lastOutput: AdapterOutput | null = null;
  let lastCheck: FormatCheckResult = { passed: false, checks: [] };

  while (attempt <= CHANNEL_FORMAT_RETRIES) {
    const result = await callStructured<AdapterOutput>({
      context,
      model: MODELS.adaptation,
      system,
      prompt: attempt === 0 ? basePrompt : `${basePrompt}\n\n${retryNote}`,
      schema: schemaFor(channel),
      maxTokens: MAX_TOKENS.adaptation,
      temperature: 1,
    });

    lastOutput = result.value;

    // Markers are inherited: anything outside the article's claim map is a
    // hard failure, because it means the adapter invented a citation (§12).
    const inherited = checkInheritedMarkers(result.value.body, claimMap);
    if (!inherited.valid) {
      await recordDiscarded(
        context,
        MODELS.adaptation,
        result.usage,
        `Cited ${inherited.unknownLabels.join(", ")}, which the article does not.`,
      );
      retryNote =
        `── YOUR PREVIOUS ATTEMPT WAS DISCARDED ──\n` +
        `You cited ${inherited.unknownLabels.join(", ")}, which do not appear in the article. ` +
        `Use only markers that are already in the article text.`;
      attempt++;
      continue;
    }

    const check = runFormatCheck(channel, result.value, voice, includeLink ? articleUrl : null);
    lastCheck = check;

    if (check.passed) {
      const output = await saveOutput({
        request,
        version,
        channel,
        result: result.value,
        check,
        articleUrl: includeLink ? articleUrl : null,
        status: "draft",
        usage: result.usage,
      });
      return { channel, output, formatCheck: check, formatFailed: false };
    }

    const failures = check.checks.filter((c) => !c.passed);
    await recordDiscarded(
      context,
      MODELS.adaptation,
      result.usage,
      `Format check failed: ${failures.map((f) => f.detail).join("; ")}`,
    );

    // The retry names the specific violation AND the actual measured value —
    // a model told the real number usually fixes it (§12.1).
    retryNote =
      `── YOUR PREVIOUS ATTEMPT FAILED THESE CHECKS ──\n` +
      failures.map((f) => `- ${f.name}: ${f.detail}`).join("\n") +
      `\n\nFix exactly these and keep everything else.`;

    attempt++;
  }

  /**
   * Last resort for X: cut it to fit.
   *
   * Length is the only format rule with an exact mechanical answer, so telling
   * a founder "cut at least 46 characters" is handing them arithmetic instead
   * of a finished post. Everything else — too few hashtags, no line break, a
   * missing core idea — is a judgment call and still goes to a person.
   *
   * The trim is recorded on the row so the edit is visible rather than silent.
   */
  if (channel === "x" && lastOutput && overLengthOnly(lastCheck)) {
    const trimmedBody = trimXPost(lastOutput.body, lastOutput.hashtags ?? []);
    const trimmed = { ...lastOutput, body: trimmedBody };
    const recheck = runFormatCheck(channel, trimmed, voice, includeLink ? articleUrl : null);

    if (recheck.passed) {
      const output = await saveOutput({
        request,
        version,
        channel,
        result: trimmed,
        check: recheck,
        articleUrl: includeLink ? articleUrl : null,
        status: "draft",
        usage: { inputTokens: 0, outputTokens: 0 },
        autoTrimmed: true,
      });

      await logInfo(
        `The X post came back over the limit twice, so it was shortened to fit. ` +
          `It is ready to review.`,
        { requestId: request.id, step: "adapt", detail: { channel } },
      );

      return { channel, output, formatCheck: recheck, formatFailed: false };
    }
  }

  // Second failure: format_failed on THIS channel only (§12.1).
  const output = lastOutput
    ? await saveOutput({
        request,
        version,
        channel,
        result: lastOutput,
        check: lastCheck,
        articleUrl: includeLink ? articleUrl : null,
        status: "format_failed",
        usage: { inputTokens: 0, outputTokens: 0 },
      })
    : null;

  await logWarn(
    `The ${channel} version did not meet its format rules after a retry. The other channels are unaffected.`,
    {
      requestId: request.id,
      step: "adapt",
      detail: { failures: lastCheck.checks.filter((c) => !c.passed).map((c) => c.detail) },
    },
  );

  return { channel, output, formatCheck: lastCheck, formatFailed: true };
}

/**
 * True when length is the ONLY thing wrong.
 *
 * Trimming fixes length and nothing else, so a post that is also missing its
 * hashtags or its core idea still needs a person. Checking this rather than
 * trimming on any failure is what keeps the automatic edit safe.
 */
function overLengthOnly(check: FormatCheckResult): boolean {
  const failed = check.checks.filter((c) => !c.passed);
  return failed.length > 0 && failed.every((c) => c.name.includes("Within 280 characters"));
}

function runFormatCheck(
  channel: ChannelName,
  output: AdapterOutput,
  voice: BrandVoice | null,
  articleUrl: string | null,
): FormatCheckResult {
  // Checks run against what a READER sees: markers are an internal mechanism
  // and are stripped before the post goes out, so counting them against the
  // character limit would reject posts that are actually within it.
  const body = stripMarkers(output.body);

  switch (channel) {
    case "linkedin":
      return checkLinkedIn({
        body,
        cta: output.cta ?? null,
        pas:
          output.problem && output.agitation && output.solution
            ? {
                problem: stripMarkers(output.problem),
                agitation: stripMarkers(output.agitation),
                solution: stripMarkers(output.solution),
              }
            : null,
        emojiAllowance: voice?.emoji_allowance ?? 3,
      });

    case "x":
      return checkX({
        body,
        hashtags: output.hashtags ?? [],
        coreIdea: output.coreIdea ?? null,
        includesLink: Boolean(articleUrl),
      });

    case "newsletter":
      return checkNewsletter({
        subject: output.subject ?? null,
        body,
        cta: output.cta ?? null,
      });
  }
}

function buildAdaptPrompt(
  request: ContentRequest,
  version: ArticleVersion,
  channel: ChannelName,
  articleUrl: string | null,
): string {
  const parts = [
    `Adapt this article for ${channelLabel(channel)}.`,
    ``,
    `Target audience: ${request.target_audience}`,
  ];

  if (articleUrl) {
    parts.push(
      ``,
      `Include this link, exactly as written, where the channel rules say it belongs:`,
      articleUrl,
    );
  } else if (channel === "x") {
    parts.push(
      ``,
      `Do NOT include a link. This post has to earn attention on its hook alone.`,
    );
  }

  parts.push(``, `── The article ──`, ``, `# ${version.title}`, ``, version.body_md);

  return parts.join("\n");
}

function channelLabel(channel: ChannelName): string {
  switch (channel) {
    case "linkedin": return "LinkedIn";
    case "x": return "X";
    case "newsletter": return "an email newsletter";
  }
}

// ─── Persistence ────────────────────────────────────────────────────────────

interface SaveOutputInput {
  request: ContentRequest;
  version: ArticleVersion;
  channel: ChannelName;
  result: AdapterOutput;
  check: FormatCheckResult;
  articleUrl: string | null;
  status: "draft" | "format_failed";
  usage: { inputTokens: number; outputTokens: number };
  /** Set when the body was shortened in code to fit the channel limit. */
  autoTrimmed?: boolean;
}

async function saveOutput(input: SaveOutputInput): Promise<ChannelOutput> {
  const db = serviceClient();
  const { request, version, channel, result, check, articleUrl, status } = input;

  // Stored as the reader will see it. The markers did their job at check time
  // and have no business reaching a recipient.
  //
  // Em dashes go the same way as in the article (saveVersion): the prompt
  // forbids them and this is the mechanical guarantee, applied to the subject
  // line and the CTA as well since those are read as carefully as the body.
  const readerBody = replaceEmDashes(stripMarkers(result.body));

  const claimMap = (version.claim_map ?? []) as ClaimMapEntry[];
  const inheritedLabels = new Set(
    (result.body.match(/\[E\d+\]/g) ?? []).map((m) => m.slice(1, -1)),
  );
  const inheritedClaims = claimMap.filter((entry) =>
    entry.labels.some((l) => inheritedLabels.has(l)),
  );

  const { data: latest } = await db
    .from(table("channel_outputs"))
    .select("version")
    .eq("request_id", request.id)
    .eq("channel", channel)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = ((latest?.version as number | undefined) ?? 0) + 1;

  const { data, error } = await db
    .from(table("channel_outputs"))
    .insert({
      request_id: request.id,
      article_version_id: version.id,
      channel,
      version: nextVersion,
      subject: result.subject ? replaceEmDashes(result.subject) : null,
      body: readerBody,
      hashtags: result.hashtags ?? [],
      cta: result.cta ? replaceEmDashes(result.cta) : null,
      includes_link: Boolean(articleUrl),
      link_url: articleUrl,
      char_count: channel === "x" ? countXCharacters(readerBody) : readerBody.length,
      claim_map: inheritedClaims as never,
      format_check: check as never,
      status,
      auto_trimmed: input.autoTrimmed ?? false,
      model_used: MODELS.adaptation,
      input_tokens: input.usage.inputTokens,
      output_tokens: input.usage.outputTokens,
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Could not save the ${channel} output: ${error?.message ?? "no row"}`);
  }

  return data as unknown as ChannelOutput;
}

/**
 * Adapts every requested channel. One broken channel never blocks the others,
 * so each is caught independently (§12.1).
 */
export async function adaptAllChannels(
  request: ContentRequest,
  version: ArticleVersion,
  voice: BrandVoice | null,
): Promise<AdaptResult[]> {
  const articleUrl = request.slug ? `${env.app.url}/a/${request.slug}` : null;
  const results: AdaptResult[] = [];

  for (const channel of request.channels) {
    try {
      results.push(await adaptChannel(request, version, voice, channel, articleUrl));
    } catch (err) {
      // A thrown error here is a provider or budget failure, not a format one.
      // The channel is recorded as failed and the rest still run.
      results.push({
        channel,
        output: null,
        formatCheck: {
          passed: false,
          checks: [
            {
              name: "Adaptation ran",
              passed: false,
              detail: err instanceof Error ? err.message : String(err),
            },
          ],
        },
        formatFailed: true,
      });
      await logWarn(`The ${channel} adaptation could not run.`, {
        requestId: request.id,
        step: "adapt",
        detail: { error: String(err) },
      });
    }
  }

  const ok = results.filter((r) => !r.formatFailed).length;
  await logInfo(
    `Adapted ${ok} of ${results.length} channels.` +
      (ok < results.length ? " The rest need attention at review." : ""),
    { requestId: request.id, step: "adapt" },
  );

  return results;
}

export { CHANNEL_LIMITS };
