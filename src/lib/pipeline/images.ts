import "server-only";
import { serviceClient, table } from "@/lib/db/client";
import { assertExecutionActive } from "./execution";
import { logWarn } from "@/lib/log";
import { callStructured } from "@/lib/providers/anthropic";
import {
  MODELS,
  MAX_TOKENS,
  ALT_TEXT_MAX_CHARS,
  IMAGE_CANDIDATE_COUNT,
} from "@/lib/constants";
import type { ArticleVersion, ContentRequest, ImageCandidate } from "@/lib/db/types";

/**
 * Images. DESIGN.md §13.
 *
 * Selected, never generated, from an openly licensed library, with the licence,
 * attribution and source URL stored alongside.
 *
 * "No image generation. A synthesised image on an article whose entire design
 * premise is verifiable sourcing would undercut the thing the system is for."
 *
 * A candidate missing licence metadata is DISCARDED, not defaulted — which is
 * why `images.licence` is NOT NULL in the schema rather than checked here.
 */

const OPENVERSE_API = "https://api.openverse.org/v1/images/";

interface OpenverseResult {
  id: string;
  title?: string;
  url: string;
  thumbnail?: string;
  foreign_landing_url?: string;
  creator?: string;
  license?: string;
  license_version?: string;
  license_url?: string;
  attribution?: string;
  width?: number;
  height?: number;
}

/**
 * Searches Openverse with a query derived from the article title and primary
 * keyword. Returns candidates for a human to pick from at gate two, or none.
 *
 * Never throws: an image is optional, and losing the whole request because a
 * free image API was slow would be the wrong trade.
 */
export async function findImageCandidates(
  request: ContentRequest,
  version: ArticleVersion,
): Promise<ImageCandidate[]> {
  try {
    const existing = await serviceClient().from(table("images")).select("*").eq("request_id", request.id);
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data?.length) return existing.data as unknown as ImageCandidate[];

    const signal = AbortSignal.timeout(12_000);
    for (const query of buildImageQueries(version)) {
    const url = new URL(OPENVERSE_API);
    url.searchParams.set("q", query);
    url.searchParams.set("page_size", String(IMAGE_CANDIDATE_COUNT));
    // Commercial use permitted and modification allowed: an agency publishes
    // these, so a non-commercial licence is not usable however good the photo.
    url.searchParams.set("license_type", "commercial,modification");
    url.searchParams.set("mature", "false");

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal,
    });

    if (!response.ok) {
      await logWarn(`Image search returned ${response.status}. Continuing without an image.`, {
        requestId: request.id,
        step: "image",
      });
      return [];
    }

    const body = (await response.json()) as { results?: OpenverseResult[] };
    const results = body.results ?? [];

    const rows = results
      // A candidate missing licence metadata is discarded, not defaulted (§13).
      .filter((r) => r.license && ["cc0", "pdm", "by", "by-sa"].includes(r.license.toLowerCase()) && /^https:\/\//i.test(r.url))
      .map((r) => ({
        request_id: request.id,
        provider: "openverse",
        provider_asset_id: r.id,
        source_page_url: r.foreign_landing_url ?? null,
        download_url: r.url,
        width: r.width ?? null,
        height: r.height ?? null,
        licence: formatLicence(r),
        licence_url: r.license_url ?? null,
        attribution_text: buildAttribution(r),
        query_used: query,
        chosen: false,
      }));

    if (rows.length === 0) continue;

    await assertExecutionActive();
    const { data, error } = await serviceClient().from(table("images")).insert(rows).select();
    if (error) {
      await logWarn("Could not store the image candidates. Continuing without an image.", {
        requestId: request.id,
        step: "image",
        detail: { error: error.message },
      });
      return [];
    }

    return (data ?? []) as unknown as ImageCandidate[];
    }
    return [];
  } catch (err) {
    await logWarn("Image search was unavailable. Continuing without an image.", {
      requestId: request.id,
      step: "image",
      detail: { error: String(err) },
    }).catch(() => undefined);
    return [];
  }
}

export function buildImageQueries(version: Pick<ArticleVersion, "title" | "primary_keyword">): string[] {
  const keyword = (version.primary_keyword ?? "").replace(/[-_]/g, " ").trim();
  const subject = `${keyword} ${version.title}`;
  // Use a short visual subject instead of appending an entire abstract headline.
  const concrete = /\b(hir(?:e|ing)|recruit\w*|resumes?|candidates?|screening|talent)\b/i.test(subject)
    ? "job interview" : null;
  const words = version.title
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 2);

  return [...new Set([concrete ?? keyword, concrete ? "office meeting" : words.join(" ")].filter(Boolean))].slice(0, 2);
}

function formatLicence(result: OpenverseResult): string {
  const name = (result.license ?? "").toUpperCase();
  return result.license_version ? `${name} ${result.license_version}` : name;
}

function buildAttribution(result: OpenverseResult): string {
  if (result.attribution) return result.attribution;
  const parts = [result.title ?? "Untitled"];
  if (result.creator) parts.push(`by ${result.creator}`);
  if (result.license) parts.push(`(${formatLicence(result)})`);
  return parts.join(" ");
}

// ─── Alt text (§13) ─────────────────────────────────────────────────────────

export const ALT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["altText"],
  properties: {
    altText: {
      type: "string",
      description: `A plain description of the image, at most ${ALT_TEXT_MAX_CHARS} characters.`,
    },
  },
} as const;

/**
 * Generated by Haiku from the article title and the image's own description,
 * capped at 125 characters, and CHECKED for that cap (§13).
 */
export async function generateAltText(
  request: ContentRequest,
  version: ArticleVersion,
  image: ImageCandidate,
): Promise<string> {
  try {
    const result = await callStructured<{ altText: string }>({
      context: { requestId: request.id, step: "image", purpose: "alt text" },
      model: MODELS.altText,
      system: [
        {
          text:
            "You write alt text for images on a published article. Describe what is IN the " +
            "image for someone who cannot see it. Do not editorialise, do not repeat the " +
            "article's headline, and never begin with \"Image of\" or \"Photo of\".\n\n" +
            `At most ${ALT_TEXT_MAX_CHARS} characters.`,
        },
      ],
      prompt: [
        `Article: ${version.title}`,
        `Image description: ${image.attribution_text ?? "no description available"}`,
      ].join("\n"),
      schema: ALT_SCHEMA,
      maxTokens: MAX_TOKENS.altText,
    });

    // Checked, not trusted: the cap is the point.
    const text = result.value.altText.trim();
    return text.length <= ALT_TEXT_MAX_CHARS ? text : `${text.slice(0, ALT_TEXT_MAX_CHARS - 1)}…`;
  } catch {
    // Better a plain description than no alt attribute at all.
    return (image.attribution_text ?? version.title).slice(0, ALT_TEXT_MAX_CHARS);
  }
}

/**
 * Downloads the chosen image to Supabase Storage so published content does not
 * depend on a third party's hotlink staying alive (§13).
 */
export async function storeChosenImage(image: ImageCandidate): Promise<string | null> {
  const db = serviceClient();

  try {
    const response = await fetch(image.download_url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    if (!/^image\/(jpeg|png|webp)(?:;|$)/i.test(contentType)) return null;
    if (Number(response.headers.get("content-length")) > 10_000_000) return null;
    const data = await response.arrayBuffer();
    if (data.byteLength > 10_000_000) return null;
    const extension = contentType.includes("png")
      ? "png"
      : contentType.includes("webp")
        ? "webp"
        : "jpg";
    const path = `articles/${image.request_id}/${image.id}.${extension}`;

    const { error } = await db.storage
      .from("images")
      .upload(path, data, { contentType, upsert: true });

    if (error) return null;

    await db.from(table("images")).update({ storage_path: path }).eq("id", image.id);
    return path;
  } catch {
    // The hotlink still works; this was belt and braces.
    return null;
  }
}

export function publicImageUrl(supabaseUrl: string, storagePath: string): string {
  return `${supabaseUrl}/storage/v1/object/public/images/${storagePath}`;
}
