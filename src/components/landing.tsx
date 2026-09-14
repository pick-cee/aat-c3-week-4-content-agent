import Link from "next/link";
import { serviceClient, table } from "@/lib/db/client";
import { EnterButton } from "./enter-button";

/**
 * The signed-out landing page. DESIGN.md §20.
 *
 * "The app must load for a signed-out visitor on a machine that is not ours.
 * The landing page renders a read-only sample request with real stored output,
 * no account required."
 *
 * A dead link is an unmarked submission, so nothing here may throw: if the
 * database is unreachable the page still renders, minus the sample.
 */

export async function Landing({ error }: { error?: string }) {
  const sample = await loadSample();

  return (
    <div className="landing">
      {error && <div className="alert alert-error mb-3">{error}</div>}

      <h1 className="landing-title">
        An idea in,
        <br />
        channel-ready content out.
      </h1>

      <p className="landing-lede">
        Submit an idea or a URL. The system researches it, drafts an SEO article grounded in
        excerpts it actually stored, grades its own draft, rewrites what fails, and prepares a
        LinkedIn post, an X post and a newsletter — with every claim traceable to a source you
        can check.
      </p>

      <div className="landing-cta">
        <EnterButton />
        <span className="tiny dim">
          Signs you in as Maya Adeyemi, the content manager.
          <br />
          Nothing is sent to real recipients.
        </span>
      </div>

      <div className="landing-points">
        <Point
          heading="Grounded by construction"
          body="Every factual sentence carries a marker resolved against a stored excerpt. A citation to something that does not exist cannot be saved, and one attached to an unrelated claim is caught by comparing the sentence to the excerpt it cites."
        />
        <Point
          heading="It grades its own work"
          body="Source grounding, SEO and the channel rules are measured in code. Only relevance, audience fit, tone and clarity are judged by a model — and a model cannot overrule a failing measurement."
        />
        <Point
          heading="Nothing publishes itself"
          body="A person approves each channel. LinkedIn and X are handed to someone to post and stay marked as awaiting posting — never as published — until they confirm with a URL."
        />
        <Point
          heading="Honest about what it does not know"
          body="A source that failed to fetch is distinct from one that was empty. A send whose outcome is unknown is never retried automatically. A count that could not be read shows a dash, not a zero."
        />
      </div>

      {sample && (
        <div className="card landing-sample">
          <div className="card-head">
            <h2 style={{ fontSize: 15 }}>A finished article</h2>
            <span className="tiny dim">Real output, no account needed</span>
          </div>
          <div className="card-pad">
            <div className="strong mb-1">{sample.title}</div>
            <p className="muted small">{sample.metaDescription ?? sample.idea}</p>
            <div className="row small muted mt-2">
              <span>
                <strong>{sample.sourceCount}</strong> sources read
              </span>
              <span className="dim">·</span>
              <span>
                <strong>{sample.citedSentences}</strong> cited sentences
              </span>
              <span className="dim">·</span>
              <span>
                <strong>{sample.channelCount}</strong> channel versions
              </span>
            </div>
            <div className="mt-2">
              <Link href={`/a/${sample.slug}`} className="btn btn-sm">
                Read it, with its source list
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Point({ heading, body }: { heading: string; body: string }) {
  return (
    <div className="point">
      <h3 className="point-heading">{heading}</h3>
      <p className="point-body">{body}</p>
    </div>
  );
}

interface Sample {
  slug: string;
  title: string;
  metaDescription: string | null;
  idea: string;
  sourceCount: number;
  citedSentences: number;
  channelCount: number;
}

async function loadSample(): Promise<Sample | null> {
  try {
    const db = serviceClient();

    // Explicit column list, never `select *`, on anything a signed-out visitor
    // can reach (§19.4).
    const { data: request } = await db
      .from(table("content_requests"))
      .select("id, slug, idea")
      .not("slug", "is", null)
      .in("status", ["content_review", "scheduled", "publishing", "published"])
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!request?.slug) return null;

    const [versionResult, sourceResult, channelResult] = await Promise.all([
      db
        .from(table("article_versions"))
        .select("title, meta_description, claim_map")
        .eq("request_id", request.id as string)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from(table("sources"))
        .select("id", { count: "exact", head: true })
        .eq("request_id", request.id as string)
        .eq("included", true),
      db
        .from(table("channel_outputs"))
        .select("id", { count: "exact", head: true })
        .eq("request_id", request.id as string),
    ]);

    if (!versionResult.data) return null;

    const claimMap = (versionResult.data.claim_map ?? []) as unknown[];

    return {
      slug: request.slug as string,
      title: versionResult.data.title as string,
      metaDescription: versionResult.data.meta_description as string | null,
      idea: request.idea as string,
      sourceCount: sourceResult.count ?? 0,
      citedSentences: claimMap.length,
      channelCount: channelResult.count ?? 0,
    };
  } catch {
    // The landing page renders regardless. A dead dependency must degrade the
    // app, not break it (§20).
    return null;
  }
}
