import "server-only";
import { serviceClient, table } from "@/lib/db/client";
import { sendEmail, escapeHtml } from "@/lib/providers/resend";
import { logWarn } from "@/lib/log";
import { env } from "@/lib/env";

/**
 * Notifications. DESIGN.md §15.6.
 *
 * "A terminal failure, a blocked_not_connected item, an uncertain row, a
 * partially_delivered broadcast, or a handoff still unposted two hours after
 * its slot notifies the request's creator, and appears in the dashboard's
 * Failures strip. This is the direct answer to the Week 1 diagnostic: an
 * important failure does not sit unnoticed, because someone is told."
 *
 * Notification never throws. A failure to send the email about a failure must
 * not become a second failure that hides the first.
 */

const APP = () => env.app.url;

export async function notifyTerminalFailure(
  requestId: string,
  status: string,
  reason: string,
): Promise<void> {
  try {
    const db = serviceClient();

    const { data: request } = await db
      .from(table("content_requests"))
      .select("id, idea, created_by, failed_step")
      .eq("id", requestId)
      .maybeSingle();

    if (!request) return;

    const { data: profile } = await db
      .from(table("profiles"))
      .select("email, full_name")
      .eq("id", request.created_by as string)
      .maybeSingle();

    const to = (profile?.email as string | undefined) ?? env.resend.replyTo;
    if (!to || !env.resend.configured) return;

    const idea = String(request.idea).slice(0, 120);
    const link = `${APP()}/requests/${requestId}`;
    const heading = headingFor(status);

    await sendEmail({
      to,
      subject: `${heading}: ${idea}`,
      html: layout(
        heading,
        `<p><strong>Request:</strong> ${escapeHtml(idea)}</p>
         <p><strong>What happened:</strong> ${escapeHtml(reason)}</p>
         ${request.failed_step ? `<p><strong>Where:</strong> the ${escapeHtml(String(request.failed_step))} step</p>` : ""}
         <p>Everything produced before this point is intact.</p>
         <p><a href="${link}" style="display:inline-block;background:#111827;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open the request</a></p>`,
      ),
      text: `${heading}\n\nRequest: ${idea}\nWhat happened: ${reason}\n\nOpen: ${link}`,
    });
  } catch (err) {
    await logWarn("Could not send the failure notification.", {
      requestId,
      detail: { error: String(err) },
    });
  }
}

function headingFor(status: string): string {
  switch (status) {
    case "budget_exceeded": return "Request stopped: budget reached";
    case "needs_human": return "Request needs you";
    case "failed": return "Request failed";
    default: return "Request update";
  }
}

/** A queued item that could not go out, and why (§15.1, §15.5). */
export async function notifyPublishProblem(
  queueId: string,
  kind: "blocked" | "uncertain" | "partial" | "failed" | "handoff_overdue",
  detail: string,
): Promise<void> {
  try {
    const db = serviceClient();

    const { data: item } = await db
      .from(table("publish_queue"))
      .select("id, request_id, channel, status")
      .eq("id", queueId)
      .maybeSingle();

    if (!item) return;

    const { data: request } = await db
      .from(table("content_requests"))
      .select("idea, created_by")
      .eq("id", item.request_id as string)
      .maybeSingle();

    const { data: profile } = await db
      .from(table("profiles"))
      .select("email")
      .eq("id", (request?.created_by as string) ?? "")
      .maybeSingle();

    const to = (profile?.email as string | undefined) ?? env.resend.replyTo;
    if (!to || !env.resend.configured) return;

    const heading = publishHeading(kind, String(item.channel));
    const link = `${APP()}/queue`;

    await sendEmail({
      to,
      subject: heading,
      html: layout(
        heading,
        `<p><strong>Channel:</strong> ${escapeHtml(String(item.channel))}</p>
         <p><strong>Status:</strong> ${escapeHtml(String(item.status))}</p>
         <p>${escapeHtml(detail)}</p>
         <p><a href="${link}" style="display:inline-block;background:#111827;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open the queue</a></p>`,
      ),
      text: `${heading}\n\nChannel: ${item.channel}\nStatus: ${item.status}\n${detail}\n\nOpen: ${link}`,
    });
  } catch (err) {
    await logWarn("Could not send the publishing notification.", {
      queueId,
      detail: { error: String(err) },
    });
  }
}

function publishHeading(kind: string, channel: string): string {
  switch (kind) {
    case "blocked":
      return `${channel} is not connected, so its post is still waiting`;
    case "uncertain":
      // The wording matters: this is precisely the state where the system
      // must not claim to know what happened (§15.5).
      return `${channel}: we cannot tell whether this went out`;
    case "partial":
      return `${channel}: some recipients did not receive it`;
    case "handoff_overdue":
      return `${channel}: a scheduled post still has not been posted`;
    default:
      return `${channel}: publishing failed`;
  }
}

/**
 * Dispatches the copy-ready packet for a handoff channel (§15.4). The system
 * does not post; it hands the content to the person who will, with a signed
 * one-time link to confirm.
 */
export async function sendHandoffPacket(input: {
  to: string;
  channel: string;
  body: string;
  subject?: string | null;
  articleUrl: string | null;
  charCount: number;
  confirmUrl: string;
  scheduledFor: string;
}): Promise<{ ok: boolean; error: string | null }> {
  if (!env.resend.configured) {
    return { ok: false, error: "Resend is not configured, so the packet could not be sent." };
  }

  const heading = `Ready to post on ${input.channel}`;

  const result = await sendEmail({
    to: input.to,
    subject: `${heading} — scheduled for ${formatTime(input.scheduledFor)}`,
    html: layout(
      heading,
      `<p>This was approved and scheduled for <strong>${escapeHtml(formatTime(input.scheduledFor))}</strong>.
        ${escapeHtml(input.channel)} does not allow this system to post on your behalf, so here is the post, ready to copy.</p>
       <p style="color:#6b7280;font-size:13px">${input.charCount} characters.</p>
       <pre style="white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;padding:16px;border-radius:8px;font-family:ui-monospace,monospace;font-size:14px;line-height:1.6">${escapeHtml(input.body)}</pre>
       ${input.articleUrl ? `<p><strong>Article link:</strong> <a href="${input.articleUrl}">${escapeHtml(input.articleUrl)}</a></p>` : ""}
       <p style="margin-top:24px">Once you have posted it, confirm with the URL so the queue reflects reality:</p>
       <p><a href="${input.confirmUrl}" style="display:inline-block;background:#111827;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Confirm the post</a></p>
       <p style="color:#6b7280;font-size:13px">Until you confirm, this shows as awaiting a manual post — never as published.</p>`,
    ),
    text: [
      heading,
      `Scheduled for ${formatTime(input.scheduledFor)}`,
      ``,
      input.body,
      ``,
      input.articleUrl ? `Article: ${input.articleUrl}` : "",
      ``,
      `Confirm once posted: ${input.confirmUrl}`,
    ].join("\n"),
  });

  return { ok: result.ok, error: result.error };
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

function layout(heading: string, inner: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
    <h1 style="margin:0 0 20px;font-size:20px;font-weight:600">${escapeHtml(heading)}</h1>
    <div style="font-size:15px;line-height:1.6">${inner}</div>
    <hr style="border:0;border-top:1px solid #e5e7eb;margin:28px 0 16px">
    <p style="color:#9ca3af;font-size:12px;margin:0">Koya Content Agent</p>
  </div>
</body></html>`;
}
