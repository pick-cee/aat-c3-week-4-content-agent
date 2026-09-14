import "server-only";
import { serviceClient, table } from "@/lib/db/client";
import { logInfo, logWarn } from "@/lib/log";
import { callStructured, callText, recordDiscarded } from "@/lib/providers/anthropic";
import { embed, toVectorLiteral } from "@/lib/providers/voyage";
import {
  buildClaimMap,
  checkMarkerIntegrity,
  labelExcerpts,
  renderExcerptsForPrompt,
  resolveLinks,
  type LabelledExcerpt,
} from "./grounding";
import {
  brandVoiceBlock,
  CITATION_BLOCK,
  LINKING_BLOCK,
  SEO_RULES_BLOCK,
} from "./prompts";
import {
  MAX_TOKENS,
  MODELS,
  DRAFTING_EXCERPT_TOKEN_BUDGET,
  EXCERPTS_PER_SECTION,
  META_DESCRIPTION_MAX_CHARS,
} from "@/lib/constants";
import { countWords, parseHeadings, slugify } from "@/lib/text";
import type {
  Angle,
  ArticleVersion,
  BrandVoice,
  ContentRequest,
  HeadingNode,
} from "@/lib/db/types";

/**
 * Article drafting. DESIGN.md §10.
 *
 * Model: Sonnet 5. Publication-quality long-form prose, one call per article,
 * the largest single token spend in the pipeline (§18.2).
 *
 * Two structural guarantees live here:
 *   · Marker integrity is enforced with a discard-and-retry, so a hallucinated
 *     citation cannot be stored (§8.3).
 *   · The model never writes a URL; it marks intent and the server substitutes
 *     the real one (rule 3).
 */

// ─── §8.2 Excerpt selection ─────────────────────────────────────────────────

/**
 * Rather than pass every excerpt, the drafting call receives the top k per
 * outline section by cosine similarity to that section's heading and intent,
 * deduplicated, capped at a token budget.
 *
 * A 60k-token source pile becomes a 12k-token prompt — roughly a 75% reduction
 * on the input side of the most expensive call in the pipeline.
 */
export async function selectExcerptsForDrafting(
  request: ContentRequest,
  angle: Angle,
): Promise<LabelledExcerpt[]> {
  const db = serviceClient();

  const sections = (angle.outline ?? []) as { heading: string; intent: string }[];
  const queries = sections.map((s) => `${s.heading}. ${s.intent}`);
  // The angle's own framing, so material central to the piece is not missed
  // by a section query that happens to be narrow.
  queries.push(`${angle.headline}. ${request.idea}`);

  const { embeddings } = await embed(queries, "query", {
    requestId: request.id,
    step: "draft",
  });

  const picked = new Map<string, { row: ExcerptRow; score: number }>();

  for (const vector of embeddings) {
    if (!vector) continue;
    const { data, error } = await db.rpc("match_excerpts", {
      p_request_id: request.id,
      p_embedding: toVectorLiteral(vector),
      p_limit: EXCERPTS_PER_SECTION,
      p_included_only: true,
    });
    if (error) throw new Error(`Could not select excerpts: ${error.message}`);

    for (const row of (data ?? []) as MatchRow[]) {
      const existing = picked.get(row.id);
      // Keep the best score an excerpt achieved against any section.
      if (!existing || row.similarity > existing.score) {
        picked.set(row.id, {
          row: {
            id: row.id,
            source_id: row.source_id,
            text: row.text,
            heading_path: row.heading_path,
            ordinal: row.ordinal,
          },
          score: row.similarity,
        });
      }
    }
  }

  // Strongest first, then truncate at the token budget: if something has to be
  // dropped it should be the least relevant thing, not whatever sorted last.
  const ordered = [...picked.values()].sort((a, b) => b.score - a.score);

  const kept: ExcerptRow[] = [];
  let tokens = 0;
  for (const { row } of ordered) {
    const cost = Math.ceil(row.text.length / 4);
    if (tokens + cost > DRAFTING_EXCERPT_TOKEN_BUDGET) continue;
    kept.push(row);
    tokens += cost;
  }

  // Re-sorted into document order so the model reads them coherently rather
  // than as a relevance-ranked jumble.
  kept.sort((a, b) =>
    a.source_id === b.source_id
      ? a.ordinal - b.ordinal
      : a.source_id.localeCompare(b.source_id),
  );

  const sourceIds = [...new Set(kept.map((r) => r.source_id))];
  const { data: sources } = await db
    .from(table("sources"))
    .select("id, title, url, site_name, published_at")
    .in("id", sourceIds);

  const sourceMap = new Map(
    (sources ?? []).map((s) => [
      s.id as string,
      {
        title: s.title as string | null,
        url: s.url as string,
        site_name: s.site_name as string | null,
        published_at: s.published_at as string | null,
      },
    ]),
  );

  // Embeddings are needed for the §8.4 vector check.
  const { data: withVectors } = await db
    .from(table("excerpts"))
    .select("id, embedding")
    .in("id", kept.map((r) => r.id));

  const vectorMap = new Map(
    (withVectors ?? []).map((r) => [r.id as string, r.embedding]),
  );

  return labelExcerpts(
    kept.map((r) => ({ ...r, embedding: vectorMap.get(r.id) })),
    sourceMap,
  );
}

interface ExcerptRow {
  id: string;
  source_id: string;
  text: string;
  heading_path: string | null;
  ordinal: number;
}

interface MatchRow extends ExcerptRow {
  similarity: number;
}

// ─── Drafting ───────────────────────────────────────────────────────────────

export interface DraftResult {
  version: ArticleVersion;
  markerRetried: boolean;
}

/**
 * Drafts an article and enforces marker integrity.
 *
 * §8.3: a marker that does not resolve to a supplied excerpt is a HARD
 * failure. The call is discarded (logged, with tokens — a rejected draft cost
 * real money), retried once with the offending identifiers named, and a second
 * failure stops the request.
 */
export async function draftArticle(
  request: ContentRequest,
  angle: Angle,
  voice: BrandVoice | null,
  excerpts: LabelledExcerpt[],
): Promise<DraftResult> {
  const context = { requestId: request.id, step: "draft", purpose: "write the article" };

  const system = [
    {
      text:
        "You write publication-quality articles for a marketing agency. The material you " +
        "are given has already been researched, fetched and approved by a human. You write " +
        "from it and from nothing else — you have no web access and no memory of this topic " +
        "that you may treat as fact.\n\n" +
        "Write markdown. Do not wrap the article in a code fence.",
      cache: true,
    },
    { text: SEO_RULES_BLOCK, cache: true },
    { text: CITATION_BLOCK, cache: true },
    { text: LINKING_BLOCK, cache: true },
    ...(voice ? [{ text: brandVoiceBlock(voice), cache: true }] : []),
  ];

  const basePrompt = buildDraftPrompt(request, angle, excerpts);

  let attempt = 0;
  let body = "";
  let markerRetried = false;
  // Local, not module-level: two requests drafting at once would otherwise
  // hand each other's retry instructions to the wrong article.
  let markerError = "";

  while (attempt <= 1) {
    const result = await callText({
      context,
      model: MODELS.drafting,
      system,
      prompt:
        attempt === 0
          ? basePrompt
          : `${basePrompt}\n\n── YOUR PREVIOUS ATTEMPT WAS DISCARDED ──\n${markerError}`,
      maxTokens: MAX_TOKENS.drafting,
      temperature: 1,
    });

    body = stripCodeFence(result.value);
    const integrity = checkMarkerIntegrity(body, excerpts);

    if (integrity.valid) break;

    // The tokens were spent whether or not the output survived (rule 10).
    await recordDiscarded(
      context,
      MODELS.drafting,
      result.usage,
      `Marker integrity failed: ${integrity.unknownLabels.join(", ")} do not exist.`,
    );

    markerError =
      `You cited ${integrity.unknownLabels.join(", ")}, which do not exist. ` +
      `The ONLY labels you may cite are: ${excerpts.map((e) => e.label).join(", ")}. ` +
      `Rewrite the article using only those.`;

    await logWarn(
      `The draft cited ${integrity.unknownLabels.join(", ")}, which do not exist. Rewriting.`,
      { requestId: request.id, step: "draft", detail: { unknown: integrity.unknownLabels } },
    );

    attempt++;
    markerRetried = true;

    if (attempt > 1) {
      // §8.3: a second failure stops the request.
      throw new Error(
        `The writer twice cited excerpts that do not exist (${integrity.unknownLabels.join(", ")}). ` +
          `Rather than store an article with invented citations, this request stopped here.`,
      );
    }
  }

  // Links: the model marked intent, the server substitutes real URLs (rule 3).
  const { body: linkedBody, intents } = substituteLinks(body, excerpts);

  const header = await extractHeader(request, angle, linkedBody);

  const claim = await buildClaimMap({
    body: linkedBody,
    excerpts,
    requestId: request.id,
    step: "draft",
  });

  const version = await saveVersion({
    request,
    angle,
    title: header.title,
    metaDescription: header.metaDescription,
    body: linkedBody,
    primaryKeyword: header.primaryKeyword || angle.primary_keyword,
    secondaryKeywords: header.secondaryKeywords ?? angle.secondary_keywords,
    claimMap: claim.claimMap,
    linkTargets: intents,
    excerptIds: excerpts.map((e) => e.excerptId),
    origin: "initial",
    parentVersionId: null,
  });

  await logInfo(
    `Wrote a ${version.word_count}-word draft with ${claim.markedCount} cited sentences.`,
    { requestId: request.id, step: "draft" },
  );

  return { version, markerRetried };
}

function stripCodeFence(text: string): string {
  const fenced = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)```\s*$/.exec(text);
  return (fenced ? fenced[1]! : text).trim();
}

function buildDraftPrompt(
  request: ContentRequest,
  angle: Angle,
  excerpts: LabelledExcerpt[],
): string {
  const outline = (angle.outline ?? []) as { heading: string; intent: string }[];

  return [
    `Write the article for this angle.`,
    ``,
    `Headline: ${angle.headline}`,
    `Primary keyword: ${angle.primary_keyword}`,
    `Secondary keywords: ${(angle.secondary_keywords ?? []).join(", ") || "none specified"}`,
    `Target audience: ${request.target_audience}`,
    `The original idea: ${request.idea}`,
    ``,
    `Outline — write every one of these as an H2 section, in this order:`,
    outline.map((s, i) => `${i + 1}. ${s.heading}\n   Purpose: ${s.intent}`).join("\n"),
    ``,
    `── Source excerpts ──`,
    `These are the ONLY material you may write from.`,
    ``,
    renderExcerptsForPrompt(excerpts),
    ``,
    `Write the article now. Start with the H1 title.`,
  ].join("\n");
}

/**
 * The model marks `((link: anchor | E12))`; the server replaces it with a real
 * markdown link to that excerpt's source URL. A link cannot be wrong because
 * the model never writes one (rule 3, §10).
 */
function substituteLinks(
  body: string,
  excerpts: LabelledExcerpt[],
): { body: string; intents: { anchor: string; label: string; excerptId: string | null; sourceId: string | null; url: string | null }[] } {
  const pattern = /\(\(link:\s*([^|]+?)\s*\|\s*(E\d+)\s*\)\)/g;
  const found: { anchor: string; label: string }[] = [];

  // Remove the markers first, leaving the bare anchor text in place.
  const cleaned = body.replace(pattern, (_match, anchor: string, label: string) => {
    found.push({ anchor: anchor.trim(), label: label.trim() });
    return anchor.trim();
  });

  const { body: linked, resolved } = resolveLinks(cleaned, found, excerpts);

  // Any URL the model wrote directly is a rule violation; strip it back to its
  // anchor text rather than publishing a URL nobody verified.
  const withoutInventedUrls = linked.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (match, anchor: string, url: string) => {
      const isResolved = resolved.some((r) => r.url === url);
      return isResolved ? match : anchor;
    },
  );

  return { body: withoutInventedUrls, intents: resolved };
}

// ─── The header (§10) ───────────────────────────────────────────────────────

export const HEADER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "metaDescription", "primaryKeyword", "secondaryKeywords"],
  properties: {
    title: { type: "string", description: "The H1 exactly as it appears in the body." },
    metaDescription: {
      type: "string",
      description: `At most ${META_DESCRIPTION_MAX_CHARS} characters.`,
    },
    primaryKeyword: { type: "string" },
    secondaryKeywords: {
      type: "array",
      description: "At most 6 secondary keywords the article actually uses.",
      items: { type: "string" },
    },
  },
} as const;

/**
 * §10: "Because the body must carry citation markers and free-form prose, the
 * body is not schema-constrained; the header is a separate strict
 * structured-outputs call over the finished body, which is cheap and reliable."
 */
async function extractHeader(
  request: ContentRequest,
  angle: Angle,
  body: string,
): Promise<{
  title: string;
  metaDescription: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
}> {
  try {
    const result = await callStructured<{
      title: string;
      metaDescription: string;
      primaryKeyword: string;
      secondaryKeywords: string[];
    }>({
      context: { requestId: request.id, step: "draft", purpose: "extract the article header" },
      model: MODELS.adaptation,
      system: [
        {
          text:
            "You extract metadata from a finished article. The title must be the article's " +
            "H1, copied exactly. The meta description summarises the article for a search " +
            `result in at most ${META_DESCRIPTION_MAX_CHARS} characters and should contain ` +
            "the primary keyword. Do not invent keywords the article does not use.",
        },
      ],
      prompt: `Primary keyword: ${angle.primary_keyword}\n\n${body.slice(0, 8_000)}`,
      schema: HEADER_SCHEMA,
      maxTokens: MAX_TOKENS.articleHeader,
    });

    return {
      title: result.value.title?.trim() || angle.headline,
      metaDescription: (result.value.metaDescription ?? "").slice(0, META_DESCRIPTION_MAX_CHARS),
      primaryKeyword: result.value.primaryKeyword?.trim() || angle.primary_keyword,
      secondaryKeywords: result.value.secondaryKeywords ?? [],
    };
  } catch {
    // The header is recoverable from the body; failing the whole draft because
    // a cheap metadata call failed would be the wrong trade.
    const h1 = parseHeadings(body).find((h) => h.level === 1);
    return {
      title: h1?.text ?? angle.headline,
      metaDescription: "",
      primaryKeyword: angle.primary_keyword,
      secondaryKeywords: angle.secondary_keywords ?? [],
    };
  }
}

// ─── Persistence ────────────────────────────────────────────────────────────

export interface SaveVersionInput {
  request: ContentRequest;
  angle: Angle | null;
  title: string;
  metaDescription: string | null;
  body: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  claimMap: unknown;
  linkTargets: unknown;
  excerptIds: string[];
  origin: "initial" | "revision" | "human_edit";
  parentVersionId: string | null;
}

/** Versions are never overwritten (§5.7). */
export async function saveVersion(input: SaveVersionInput): Promise<ArticleVersion> {
  const db = serviceClient();

  const { data: latest } = await db
    .from(table("article_versions"))
    .select("version")
    .eq("request_id", input.request.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const version = ((latest?.version as number | undefined) ?? 0) + 1;

  const headings: HeadingNode[] = parseHeadings(input.body).map((h) => ({
    level: h.level,
    text: h.text,
  }));

  const { data, error } = await db
    .from(table("article_versions"))
    .insert({
      request_id: input.request.id,
      version,
      angle_id: input.angle?.id ?? null,
      title: input.title,
      meta_description: input.metaDescription,
      body_md: input.body,
      primary_keyword: input.primaryKeyword,
      secondary_keywords: input.secondaryKeywords,
      word_count: countWords(input.body),
      headings: headings as unknown as HeadingNode[],
      claim_map: input.claimMap as never,
      link_targets: input.linkTargets as never,
      excerpt_ids_used: input.excerptIds,
      origin: input.origin,
      parent_version_id: input.parentVersionId,
      model_used: MODELS.drafting,
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Could not save the article version: ${error?.message ?? "no row returned"}`);
  }

  // The permalink is generated once and is stable thereafter (§10.1).
  if (!input.request.slug) {
    await assignSlug(input.request.id, input.title);
  }

  return data as unknown as ArticleVersion;
}

/** Slugified title with a short suffix for collisions (§10.1). */
async function assignSlug(requestId: string, title: string): Promise<void> {
  const db = serviceClient();
  const base = slugify(title) || "article";

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${randomSuffix()}`;
    const { error } = await db
      .from(table("content_requests"))
      .update({ slug: candidate })
      .eq("id", requestId);

    if (!error) return;
    if (!error.message.includes("duplicate")) return;
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}
