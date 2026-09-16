import { serviceClient, table } from "@/lib/db/client";
import { verifyHandoffToken } from "@/lib/crypto";
import { ConfirmForm } from "./form";
import { CHANNEL_LABELS, formatWhen } from "@/components/status";
import type { ChannelOutput, PublishQueueItem } from "@/lib/db/types";

/**
 * The handoff confirmation page. DESIGN.md §15.4.
 *
 * "The confirmation link opens a small page with the post text ready to copy,
 * the image to download, and one field: the URL of the post once made."
 *
 * "The confirmation link is a signed token with an expiry, scoped to one queue
 * row. It is not a guessable id, because that link is the one URL in this
 * system a stranger could act on."
 *
 * §21.1: opened twice, the second open shows the recorded URL and does not
 * create a second record.
 */

export const dynamic = "force-dynamic";

export default async function ConfirmPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const verified = verifyHandoffToken(token);

  if (!verified.valid) {
    return (
      <div style={{ maxWidth: 560, margin: "48px auto" }}>
        <div className="card card-pad">
          <h1 style={{ fontSize: 19, marginBottom: 8 }}>{reasonHeading(verified.reason)}</h1>
          <p className="muted mb-0">{reasonBody(verified.reason)}</p>
        </div>
      </div>
    );
  }

  const db = serviceClient();

  const { data: itemRow } = await db
    .from(table("publish_queue"))
    .select("*")
    .eq("id", verified.payload.queueId)
    .maybeSingle();

  const item = itemRow as unknown as PublishQueueItem | null;

  if (!item) {
    return (
      <div style={{ maxWidth: 560, margin: "48px auto" }}>
        <div className="card card-pad">
          <h1 style={{ fontSize: 19, marginBottom: 8 }}>This post is no longer scheduled</h1>
          <p className="muted mb-0">It was cancelled or removed. Nothing needs posting.</p>
        </div>
      </div>
    );
  }

  const { data: outputRow } = await db
    .from(table("channel_outputs"))
    .select("body, subject, link_url, char_count, hashtags")
    .eq("id", item.channel_output_id)
    .maybeSingle();

  const output = outputRow as unknown as Pick<
    ChannelOutput,
    "body" | "subject" | "link_url" | "char_count" | "hashtags"
  > | null;

  // Opened twice: show what was recorded rather than creating a second record.
  const alreadyConfirmed = item.status === "posted_manually";

  return (
    <div style={{ maxWidth: 620, margin: "32px auto" }}>
      <div className="card">
        <div className="card-head">
          <div>
            <h1 style={{ fontSize: 18 }}>
              {alreadyConfirmed ? "Already confirmed" : `Ready to post on ${CHANNEL_LABELS[item.channel]}`}
            </h1>
            <div className="tiny dim">Scheduled for {formatWhen(item.scheduled_for)}</div>
          </div>
        </div>

        <div className="card-pad">
          {alreadyConfirmed ? (
            <div className="alert alert-ok mb-2">
              <strong>This was confirmed as posted.</strong>
              {item.platform_url && (
                <div className="mt-1">
                  <a href={item.platform_url} target="_blank" rel="noopener noreferrer">
                    {item.platform_url}
                  </a>
                </div>
              )}
              <div className="tiny mt-1">
                Confirmed {formatWhen(item.confirmed_at)}. Opening this link again does not create
                a second record.
              </div>
            </div>
          ) : (
            <p className="small muted">
              {CHANNEL_LABELS[item.channel]} does not allow this system to post on the agency&rsquo;s
              behalf, so here is the approved post, ready to copy. Once it is live, paste the URL
              below, until then it stays marked as awaiting posting, never as published.
            </p>
          )}

          {output && (
            <>
              {output.subject && (
                <div className="small mb-1">
                  <span className="dim">Subject: </span>
                  <span className="strong">{output.subject}</span>
                </div>
              )}

              <div className="preview mb-1">{output.body}</div>

              <div className="row tiny dim mb-2">
                <span>{output.char_count} characters</span>
                {output.hashtags.length > 0 && <span>· {output.hashtags.join(" ")}</span>}
                {output.link_url && (
                  <span>
                    ·{" "}
                    <a href={output.link_url} target="_blank" rel="noopener noreferrer">
                      article link
                    </a>
                  </span>
                )}
              </div>
            </>
          )}

          {!alreadyConfirmed && (
            <ConfirmForm token={token} channel={CHANNEL_LABELS[item.channel]} body={output?.body ?? ""} />
          )}
        </div>
      </div>
    </div>
  );
}

function reasonHeading(reason: "malformed" | "bad_signature" | "expired"): string {
  return reason === "expired" ? "This link has expired" : "This link is not valid";
}

function reasonBody(reason: "malformed" | "bad_signature" | "expired"): string {
  return reason === "expired"
    ? "Confirmation links expire for safety. Ask for a new one from the queue and it will be re-sent."
    : "This link could not be verified. If you were sent it by email, use the original rather than a copied fragment.";
}
