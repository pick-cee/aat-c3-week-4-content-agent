import "server-only";
import { Resend } from "resend";
import { env } from "@/lib/env";

/**
 * Resend, for newsletter delivery and operational notifications.
 *
 * DEMO_MODE redirects every send to one address and the result is stored as a
 * DRY RUN — a distinct value, never rendered as a real publish (§19.6).
 */

let client: Resend | null = null;

function resend(): Resend {
  client ??= new Resend(env.resend.apiKey);
  return client;
}

export interface SendResult {
  ok: boolean;
  /** The provider's identifier. `published` requires one (§2.9). */
  messageId: string | null;
  error: string | null;
  /** Whether this was redirected by DEMO_MODE. */
  isDryRun: boolean;
  /** Who it would have gone to, when redirected. */
  intendedTo: string;
  retryable: boolean;
}

export interface SendInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /** Passed to the provider so a retry cannot deliver twice. */
  idempotencyKey?: string;
}

export async function sendEmail(input: SendInput): Promise<SendResult> {
  const intendedTo = input.to;
  const demo = env.app.demoMode;
  const redirect = env.app.demoRedirectEmail || env.resend.replyTo;

  // In demo mode with nowhere safe to redirect, refuse rather than mail a
  // real person by accident.
  if (demo && !redirect) {
    return {
      ok: false,
      messageId: null,
      error:
        "DEMO_MODE is on but DEMO_REDIRECT_EMAIL is not set, so the message was not sent " +
        "rather than risk mailing a real recipient.",
      isDryRun: true,
      intendedTo,
      retryable: false,
    };
  }

  const to = demo ? redirect : input.to;

  try {
    const { data, error } = await resend().emails.send(
      {
        from: env.resend.from,
        to,
        subject: demo ? `[DRY RUN → ${intendedTo}] ${input.subject}` : input.subject,
        html: demo ? demoBanner(intendedTo) + input.html : input.html,
        text: demo ? `[DRY RUN, intended for ${intendedTo}]\n\n${input.text}` : input.text,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      },
      input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
    );

    if (error) {
      return {
        ok: false,
        messageId: null,
        error: error.message,
        isDryRun: demo,
        intendedTo,
        // A 4xx from the provider will say the same thing next time.
        retryable: /rate|timeout|5\d\d/i.test(error.message),
      };
    }

    return {
      ok: true,
      messageId: data?.id ?? null,
      error: null,
      isDryRun: demo,
      intendedTo,
      retryable: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      messageId: null,
      error: message,
      isDryRun: demo,
      intendedTo,
      retryable: true,
    };
  }
}

function demoBanner(intendedTo: string): string {
  return `<div style="background:#fef3c7;border:1px solid #f59e0b;padding:12px;margin-bottom:20px;font-family:system-ui,sans-serif;font-size:14px;color:#78350f;border-radius:6px">
<strong>Dry run.</strong> DEMO_MODE is on, so this was redirected here instead of going to <code>${escapeHtml(intendedTo)}</code>. Nothing was sent to the real recipient.
</div>`;
}

/**
 * Reads a message back by id, for reconciling an `uncertain` send (§15.5).
 * "An automated system that cannot tell whether it did something must ask,
 * not guess" — this is the asking.
 */
export async function getEmailStatus(messageId: string): Promise<{
  found: boolean;
  status: string | null;
  error: string | null;
}> {
  try {
    const { data, error } = await resend().emails.get(messageId);
    if (error) return { found: false, status: null, error: error.message };
    return {
      found: Boolean(data),
      status: (data as { last_event?: string } | null)?.last_event ?? "sent",
      error: null,
    };
  } catch (err) {
    return {
      found: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
