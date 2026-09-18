import "server-only";
import { PermanentPipelineError } from "./errors";
import { assertExecutionActive, executionLeaseId } from "./execution";
import { channelRevisionPrompt, channelRevisionSourceIssues } from "./channel-revision";
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

export interface AdaptResult {
  channel: ChannelName;
  output: ChannelOutput | null;
  formatCheck: FormatCheckResult;

  formatFailed: boolean;
}

export async function adaptChannel(
  request: ContentRequest,
  version: ArticleVersion,
  voice: BrandVoice | null,
  channel: ChannelName,
  articleUrl: string | null,
  revision?: { id: string; previous: ChannelOutput; note: string },
): Promise<AdaptResult> {
  const context = {
    requestId: request.id,
    step: "adapt",
    purpose: revision ? `revise ${channel}` : `adapt for ${channel}`,
  };

  const claimMap = (version.claim_map ?? []) as ClaimMapEntry[];
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

  if (revision && (revision.previous.article_version_id !== version.id || revision.previous.channel !== channel)) {
    throw new PermanentPipelineError("The channel revision does not match this article and platform.");
  }
  const basePrompt = buildAdaptPrompt(request, version, channel, includeLink ? articleUrl : null) +
    (revision ? "\n\n" + channelRevisionPrompt(revision.previous, revision.note) : "");

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

    const inherited = checkInheritedMarkers(result.value.body, claimMap);
    const sourceIssues = revision ? channelRevisionSourceIssues([result.value.subject, result.value.body].filter(Boolean).join("\n"), version, includeLink ? articleUrl : null) : [];
    if (!inherited.valid || sourceIssues.length) {
      await recordDiscarded(
        context,
        MODELS.adaptation,
        result.usage,
        [...(inherited.valid ? [] : [`Cited ${inherited.unknownLabels.join(", ")}, which the article does not.`]), ...sourceIssues].join(" "),
      result.callId,
      );
      retryNote =
        `── YOUR PREVIOUS ATTEMPT WAS DISCARDED ──\n` +
        `You cited ${inherited.unknownLabels.join(", ")}, which do not appear in the article. ` +
        `Use only markers that are already in the article text. ${sourceIssues.join(" ")} Use only facts and links in the article.`;
      attempt++;
      if (attempt > CHANNEL_FORMAT_RETRIES) {
        throw new PermanentPipelineError("The channel repeatedly cited sources absent from the article or introduced unsupported figures or links. Its output was not saved.");
      }
      continue;
    }

    lastOutput = result.value;

    const check = runFormatCheck(channel, result.value, voice, includeLink ? articleUrl : null);
    lastCheck = check;

    if (check.passed) {
      const output = await saveOutput({
        revisionId: revision?.id,
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
      result.callId,
    );
    retryNote =
      `── YOUR PREVIOUS ATTEMPT FAILED THESE CHECKS ──\n` +
      failures.map((f) => `- ${f.name}: ${f.detail}`).join("\n") +
      `\n\nFix exactly these and keep everything else.`;

    attempt++;
  }


  if (channel === "x" && lastOutput && overLengthOnly(lastCheck)) {
    const trimmedBody = trimXPost(lastOutput.body, lastOutput.hashtags ?? []);
    const trimmed = { ...lastOutput, body: trimmedBody };
    const recheck = runFormatCheck(channel, trimmed, voice, includeLink ? articleUrl : null);

    if (recheck.passed) {
      const output = await saveOutput({
        revisionId: revision?.id,
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
  const output = lastOutput
    ? await saveOutput({
        revisionId: revision?.id,
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

interface SaveOutputInput {
  revisionId?: string;
  request: ContentRequest;
  version: ArticleVersion;
  channel: ChannelName;
  result: AdapterOutput;
  check: FormatCheckResult;
  articleUrl: string | null;
  status: "draft" | "format_failed";
  usage: { inputTokens: number; outputTokens: number };

  autoTrimmed?: boolean;
}

async function saveOutput(input: SaveOutputInput): Promise<ChannelOutput> {
  await assertExecutionActive();
  const db = serviceClient();
  const { request, version, channel, result, check, articleUrl, status } = input;
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

  const payload = {
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
    };
  const { data, error } = input.revisionId
    ? await db.rpc("save_channel_revision", { p_request_id: request.id, p_job_id: input.revisionId,
        p_lease_id: executionLeaseId() ?? null, p_output: payload }).single()
    : await db.from(table("channel_outputs")).insert(payload).select().single();

  if (error || !data) {
    throw new Error(`Could not save the ${channel} output: ${error?.message ?? "no row"}`);
  }

  return data as unknown as ChannelOutput;
}

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
