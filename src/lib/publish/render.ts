import "server-only";
import { escapeHtml } from "@/lib/providers/resend";
import { env } from "@/lib/env";
import type { ChannelOutput, Recipient } from "@/lib/db/types";

/**
 * Newsletter HTML.
 *
 * Deliberately plain: inline styles, a single column, no external CSS and no
 * remote images beyond the article's own. Email clients are not browsers, and
 * a newsletter that renders as a wall of unstyled text in Outlook is a
 * delivery failure that no status column will tell you about.
 */

export function renderNewsletterHtml(output: ChannelOutput, recipient: Recipient): string {
  const body = markdownToEmailHtml(output.body);
  const unsubscribe = `${env.app.url}/unsubscribe?c=${encodeURIComponent(
    recipient.channel,
  )}&h=${encodeURIComponent(recipient.handle)}`;

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(output.subject ?? "Koya Content")}</title></head>
<body style="margin:0;padding:24px 12px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;-webkit-font-smoothing:antialiased">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden">
        <tr><td style="padding:32px 32px 8px">
          ${body}
        </td></tr>
        ${
          output.link_url
            ? `<tr><td style="padding:8px 32px 32px">
                 <a href="${escapeHtml(output.link_url)}" style="display:inline-block;background:#111827;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:500;font-size:15px">${escapeHtml(output.cta ?? "Read the full article")}</a>
               </td></tr>`
            : ""
        }
        <tr><td style="padding:20px 32px 28px;border-top:1px solid #e5e7eb">
          <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.5">
            You are receiving this because you subscribed to updates from Koya Talent.<br>
            <a href="${escapeHtml(unsubscribe)}" style="color:#6b7280">Unsubscribe</a> — it takes effect immediately.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * A small markdown subset, rendered with inline styles.
 *
 * Not a general markdown library: the adapter produces a known shape
 * (headings, paragraphs, bullets, bold, italic, links), and a full parser
 * would pull in a dependency to handle syntax that never appears here.
 */
export function markdownToEmailHtml(markdown: string): string {
  const blocks = markdown.split(/\n\s*\n/);
  const out: string[] = [];

  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;

    const heading = /^(#{1,6})\s+(.+)$/.exec(block);
    if (heading) {
      const level = Math.min(heading[1]!.length, 3);
      const size = level === 1 ? 22 : level === 2 ? 18 : 16;
      out.push(
        `<h${level} style="margin:24px 0 10px;font-size:${size}px;font-weight:600;line-height:1.3;color:#111827">${inline(heading[2]!)}</h${level}>`,
      );
      continue;
    }

    if (/^\s*[-*+]\s+/m.test(block)) {
      const items = block
        .split("\n")
        .filter((line) => /^\s*[-*+]\s+/.test(line))
        .map(
          (line) =>
            `<li style="margin:0 0 8px;line-height:1.6">${inline(line.replace(/^\s*[-*+]\s+/, ""))}</li>`,
        );
      out.push(`<ul style="margin:0 0 16px;padding-left:22px;font-size:15px">${items.join("")}</ul>`);
      continue;
    }

    if (/^\s*>/.test(block)) {
      out.push(
        `<blockquote style="margin:0 0 16px;padding:12px 16px;border-left:3px solid #d1d5db;background:#f9fafb;font-size:15px;line-height:1.6;color:#374151">${inline(
          block.replace(/^\s*>\s?/gm, ""),
        )}</blockquote>`,
      );
      continue;
    }

    out.push(
      `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#374151">${inline(block)}</p>`,
    );
  }

  return out.join("\n");
}

/** Inline formatting. Escaping happens first, so no markup can be injected. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" style="color:#1d4ed8;text-decoration:underline">$1</a>',
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<em>$1</em>")
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, '<code style="background:#f3f4f6;padding:2px 5px;border-radius:4px;font-size:14px">$1</code>')
    .replace(/\n/g, "<br>");
}
