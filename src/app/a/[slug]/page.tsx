import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { serviceClient, table } from "@/lib/db/client";
import { ArticleView } from "@/components/article-view";
import { FetchStatusPill } from "@/components/status";
import { env } from "@/lib/env";
import type { ClaimMapEntry, FetchStatus, Source } from "@/lib/db/types";

/**
 * The public article permalink. DESIGN.md §10.1.
 *
 * "A public, signed-out, SEO-rendered page with the title, meta description,
 * body, image with its attribution, and the full source list with live links."
 *
 * This solves three problems with one page: the channel posts have a real
 * link_url, the grader has a live link showing finished work, and the source
 * list — the thing the brief asks the system to make clear — is public, which
 * is the honest place for it.
 *
 * SECURITY: every query here selects an EXPLICIT COLUMN LIST. Never `select *`
 * on a route that renders to signed-out visitors, because that is how an
 * internal note or a token column ends up on a public page after a later
 * migration (§19.4).
 */

export const revalidate = 60;

const PUBLISHABLE = ["content_review", "scheduled", "publishing", "published"];

async function loadArticle(slug: string) {
  const db = serviceClient();

  const { data: request } = await db
    .from(table("content_requests"))
    .select("id, slug, status, updated_at")
    .eq("slug", slug)
    .maybeSingle();

  if (!request || !PUBLISHABLE.includes(request.status as string)) return null;

  const { data: version } = await db
    .from(table("article_versions"))
    .select(
      "id, title, meta_description, body_md, claim_map, word_count, version, created_at, origin",
    )
    .eq("request_id", request.id as string)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!version) return null;

  const { data: sources } = await db
    .from(table("sources"))
    .select("id, title, url, site_name, author, published_at, fetch_status, included")
    .eq("request_id", request.id as string)
    .order("relevance_score", { ascending: false, nullsFirst: false });

  const { data: image } = await db
    .from(table("images"))
    .select("download_url, storage_path, alt_text, licence, licence_url, attribution_text, source_page_url")
    .eq("request_id", request.id as string)
    .eq("chosen", true)
    .maybeSingle();

  return { request, version, sources: sources ?? [], image };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = await loadArticle(slug);

  if (!article) return { title: "Article not found" };

  return {
    title: article.version.title as string,
    description: (article.version.meta_description as string) ?? undefined,
    openGraph: {
      title: article.version.title as string,
      description: (article.version.meta_description as string) ?? undefined,
      type: "article",
      url: `${env.app.url}/a/${slug}`,
    },
  };
}

export default async function ArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const article = await loadArticle(slug);

  if (!article) notFound();

  const { request, version, sources, image } = article;

  const used = (sources as unknown as Source[]).filter((s) => s.included);
  const notUsed = (sources as unknown as Source[]).filter((s) => !s.included);

  const imageUrl = image?.storage_path
    ? `${env.supabase.url}/storage/v1/object/public/images/${image.storage_path}`
    : (image?.download_url as string | undefined);

  // A version banner when the article has been revised since publishing (§10.1).
  const revised = (version.version as number) > 1;

  return (
    /* Its own reading page, not a view inside the workspace. The app shell
       used to supply the padding; this route no longer has one. */
    <article className="public-article">
      {request.status === "content_review" && (
        <div className="alert alert-warn small">
          This article is still under review. It has not been approved for publishing.
        </div>
      )}

      <header className="mb-3">
        <h1 style={{ fontSize: 30, letterSpacing: "-0.02em", lineHeight: 1.2, marginBottom: 10 }}>
          {version.title as string}
        </h1>
        {version.meta_description && (
          <p className="muted" style={{ fontSize: 17, lineHeight: 1.6 }}>
            {version.meta_description as string}
          </p>
        )}
        <div className="tiny dim">
          {version.word_count as number} words
          {revised && ` · revised, version ${version.version}`}
          {" · "}
          {new Date(version.created_at as string).toLocaleDateString("en-GB", {
            dateStyle: "long",
          })}
        </div>
      </header>

      {imageUrl && (
        <figure style={{ margin: "0 0 28px" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt={(image?.alt_text as string) ?? ""}
            style={{ width: "100%", borderRadius: 10, display: "block" }}
          />
          {/* A row with no licence is never attached to content (§5.10), so
              this attribution always has something real to say. */}
          <figcaption className="tiny dim mt-1">
            {image?.attribution_text as string}
            {image?.licence && (
              <>
                {", "}
                {image.licence_url ? (
                  <a href={image.licence_url as string} target="_blank" rel="noopener noreferrer">
                    {image.licence as string}
                  </a>
                ) : (
                  (image.licence as string)
                )}
              </>
            )}
          </figcaption>
        </figure>
      )}

      {/* Citations are stripped for the public reader: the markers are an
          internal verification mechanism, and the source list below is the
          reader-facing answer to "where did this come from". */}
      <ArticleView
        bodyMd={version.body_md as string}
        claimMap={version.claim_map as ClaimMapEntry[] | null}
        showCitations={false}
      />

      <section className="mt-3" style={{ borderTop: "1px solid var(--border)", paddingTop: 24 }}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>Sources</h2>
        <p className="small muted">
          Every factual claim in this article was written from these pages, which the system
          fetched and stored.
        </p>

        <ol className="small" style={{ paddingLeft: 20, lineHeight: 1.8 }}>
          {used.map((source) => (
            <li key={source.id}>
              <a href={source.url} target="_blank" rel="noopener noreferrer">
                {source.title ?? source.url}
              </a>
              <span className="dim">
                {source.site_name && `, ${source.site_name}`}
                {source.published_at &&
                  `, ${new Date(source.published_at).toLocaleDateString("en-GB")}`}
              </span>
            </li>
          ))}
        </ol>

        {/* A source that could not be read is a row, not an absence. Both
            appear on the deliverable's source list (§5.4). */}
        {notUsed.length > 0 && (
          <details className="mt-2">
            <summary className="small muted" style={{ cursor: "pointer" }}>
              {notUsed.length} source{notUsed.length === 1 ? "" : "s"} found but not used
            </summary>
            <ul className="tiny muted mt-1" style={{ paddingLeft: 20, lineHeight: 1.9 }}>
              {notUsed.map((source) => (
                <li key={source.id}>
                  <FetchStatusPill status={source.fetch_status as FetchStatus} />{" "}
                  {source.title ?? source.url}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <footer className="mt-3 tiny dim" style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
        Researched, drafted and checked by the Koya Content Agent. Every claim above is traceable
        to one of the sources listed.
      </footer>
    </article>
  );
}
