import "server-only";
import { serviceClient, table } from "@/lib/db/client";
import type { LogLevel, PipelineStep } from "@/lib/db/types";

/**
 * Every state transition writes a row. Every failure writes one with a
 * plain-language `message` a non-engineer can read and a `detail` an engineer
 * can debug from. DESIGN.md §5.15, §17.
 */

// ─── Redaction. DESIGN.md §19.8, §19.5b. ────────────────────────────────────

const SECRET_KEY_PATTERN =
  /(token|secret|password|api[_-]?key|authorization|bearer|credential|signature|access[_-]?token|refresh[_-]?token)/i;

/** Recognisable secret shapes, in case one arrives inside a free-text string. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,        // Anthropic
  /\bfc-[a-f0-9]{24,}\b/gi,            // Firecrawl
  /\bre_[A-Za-z0-9_-]{20,}\b/g,        // Resend
  // OpenAI embeddings. Covers sk-proj-, sk-svcacct- and the classic sk- form;
  // the Anthropic pattern above is matched first, so sk-ant- is not caught here.
  /\bsk-(?:proj|svcacct|admin)?-?[A-Za-z0-9_-]{20,}\b/g,
  /\bpa-[A-Za-z0-9_-]{20,}\b/g,        // Voyage, kept: old logs may hold one
  /\bsb_secret_[A-Za-z0-9_-]{16,}\b/g, // Supabase service role
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\bEA[A-Za-z0-9]{80,}\b/g,           // Meta access token
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

/**
 * Contact details are the most sensitive data in this system and never reach
 * activity_log (§19.5b). Emails and phone numbers are masked rather than
 * removed, because "who did this broadcast skip" still has to be answerable.
 */
const EMAIL_PATTERN = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const PHONE_PATTERN = /\+\d{6,15}\b/g;

export function redact<T>(value: T): T {
  return redactValue(value, 0) as T;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 8) return "[truncated: too deep]";
  if (value == null) return value;

  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    // Cap array length: a log line is a diagnostic, not a data dump.
    const capped = value.slice(0, 50).map((v) => redactValue(v, depth + 1));
    if (value.length > 50) capped.push(`[${value.length - 50} more]`);
    return capped;
  }

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // A key that names a secret has its value dropped entirely, whatever it
      // looks like. Matching on the key is what catches a secret that does not
      // match any known value pattern.
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redactValue(v, depth + 1);
    }
    return out;
  }

  return String(value);
}

function redactString(input: string): string {
  let out = input;
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, "[redacted]");
  out = out.replace(EMAIL_PATTERN, (_m, first, domain) => `${first}***${domain}`);
  out = out.replace(PHONE_PATTERN, (m) => `${m.slice(0, 4)}***${m.slice(-2)}`);
  // Long strings in a log are almost always a page body that belongs in a table.
  return out.length > 4_000 ? `${out.slice(0, 4_000)}… [${out.length} chars total]` : out;
}

// ─── Writing ────────────────────────────────────────────────────────────────

export interface LogOptions {
  requestId?: string | null;
  queueId?: string | null;
  step?: PipelineStep | string | null;
  level?: LogLevel;
  detail?: unknown;
  actorId?: string | null;
}

/**
 * Logging must never break the thing it is observing, so a failed insert is
 * reported to the console and swallowed. The one consequence that does matter
 * — an unrecorded model call making a cost total untrustworthy — is handled by
 * `cost_complete`, not here (§5.3).
 */
export async function logActivity(message: string, options: LogOptions = {}): Promise<void> {
  const { requestId, queueId, step, level = "info", detail, actorId } = options;

  const line = `[${level}]${step ? ` [${step}]` : ""} ${message}`;
  if (level === "error") console.error(line, detail ?? "");
  else if (level === "warn") console.warn(line, detail ?? "");

  try {
    await serviceClient().from(table("activity_log")).insert({
      request_id: requestId ?? null,
      queue_id: queueId ?? null,
      step: step ?? null,
      level,
      message,
      detail: detail === undefined ? null : (redact(detail) as Record<string, unknown>),
      actor_id: actorId ?? null,
    });
  } catch (err) {
    console.error("[log] could not write activity_log:", err);
  }
}

export const logInfo = (message: string, options: Omit<LogOptions, "level"> = {}) =>
  logActivity(message, { ...options, level: "info" });

export const logWarn = (message: string, options: Omit<LogOptions, "level"> = {}) =>
  logActivity(message, { ...options, level: "warn" });

export const logError = (message: string, options: Omit<LogOptions, "level"> = {}) =>
  logActivity(message, { ...options, level: "error" });
