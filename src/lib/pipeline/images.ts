import "server-only";
import { serviceClient, table } from "@/lib/db/client";
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
  const query = buildQuery(version);

  try {
    const url = new URL(OPENVERSE_API);
    url.searchParams.set("q", query);
    url.searchParams.set("page_size", String(IMAGE_CANDIDATE_COUNT));
    // Commercial use permitted and modification allowed: an agency publishes
    // these, so a non-commercial licence is not usable however good the photo.
    url.searchParams.set("license_type", "commercial,modification");
    url.searchParams.set("mature", "false");

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
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
      .filter((r) => r.license && r.url)
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

    if (rows.length === 0) return [];

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
  } catch (err) {
    await logWarn("Image search was unavailable. Continuing without an image.", {
      requestId: request.id,
      step: "image",
      detail: { error: String(err) },
    });
    return [];
  }
}

function buildQuery(version: ArticleVersion): string {
  // The keyword alone is usually too abstract to return a usable photograph,
  // and the full title is too specific. Keyword plus the title's concrete
  // nouns is what actually matches stock imagery.
  const words = version.title
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 4);

  return [version.primary_keyword, ...words].filter(Boolean).join(" ").slice(0, 80);
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
    const extension = contentType.includes("png")
      ? "png"
      : contentType.includes("webp")
        ? "webp"
        : "jpg";
    const path = `articles/${image.request_id}/${image.id}.${extension}`;

    const { error } = await db.storage
      .from(table("images"))
      .upload(path, await response.arrayBuffer(), { contentType, upsert: true });

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
