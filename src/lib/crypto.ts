import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { env } from "@/lib/env";
import { HANDOFF_TOKEN_TTL_MS } from "@/lib/constants";

/**
 * Token encryption, signed links, and constant-time comparison.
 * DESIGN.md §19.2, §19.5.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard.
const TAG_BYTES = 16;

function key(): Buffer {
  const hex = env.secrets.tokenEncryptionKey;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes) for AES-256-GCM. " +
        "Generate one with: openssl rand -hex 32",
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Connector tokens at rest. Stored layout: iv | authTag | ciphertext, so one
 * bytea column carries everything needed to decrypt and nothing else.
 */
export function encryptToken(plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * Decryption happens only inside the publish path on the server (§19.2).
 * A tampered or truncated value throws rather than returning something
 * plausible — an auth tag failure is the whole reason GCM was chosen.
 */
export function decryptToken(stored: Buffer | Uint8Array | string): string {
  const buf = normaliseBytea(stored);
  if (buf.length <= IV_BYTES + TAG_BYTES) {
    throw new Error("Encrypted token is too short to be valid.");
  }

  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** PostgREST returns bytea as a `\x…` hex string; the pg driver returns Buffer. */
function normaliseBytea(value: Buffer | Uint8Array | string): Buffer {
  if (typeof value === "string") {
    return Buffer.from(value.startsWith("\\x") ? value.slice(2) : value, "hex");
  }
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

// ─── Constant-time comparison ───────────────────────────────────────────────

/**
 * `timingSafeEqual` throws on length mismatch, which itself leaks length. The
 * HMAC wrapper equalises both inputs to 32 bytes first, so this is safe on
 * arbitrary strings and still constant-time in the value.
 */
export function safeCompare(a: string, b: string): boolean {
  const salt = randomBytes(16);
  const ha = createHmac("sha256", salt).update(a).digest();
  const hb = createHmac("sha256", salt).update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Cron authentication (§19.5). An unauthenticated publish endpoint is a
 * stranger's message to your audience.
 */
export function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  const presented = header.startsWith("Bearer ") ? header.slice(7) : header;
  return safeCompare(presented.trim(), env.secrets.cronSecret);
}

// ─── Handoff confirmation links ─────────────────────────────────────────────

/**
 * The one URL in this system a stranger could act on (§15.4), so it is a
 * signed, expiring, single-row token rather than a guessable id.
 *
 * Format: base64url(payload).hmac — self-contained, so confirming needs no
 * server-side token table and a replay after expiry fails on the timestamp
 * rather than on a lookup that might have been cleaned up.
 */
export interface HandoffTokenPayload {
  queueId: string;
  channel: string;
  issuedAt: number;
  expiresAt: number;
}

export function signHandoffToken(queueId: string, channel: string): string {
  const payload: HandoffTokenPayload = {
    queueId,
    channel,
    issuedAt: Date.now(),
    expiresAt: Date.now() + HANDOFF_TOKEN_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", env.secrets.handoffTokenSecret)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${mac}`;
}

export type HandoffTokenResult =
  | { valid: true; payload: HandoffTokenPayload }
  // The reason is shown to the person holding the link, so it is written for
  // them: "this link has expired" beats "invalid token".
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyHandoffToken(token: string): HandoffTokenResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, reason: "malformed" };

  const [encoded, mac] = parts as [string, string];
  const expected = createHmac("sha256", env.secrets.handoffTokenSecret)
    .update(encoded)
    .digest("base64url");

  if (!safeCompare(mac, expected)) return { valid: false, reason: "bad_signature" };

  let payload: HandoffTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed" };
  }

  if (!payload.queueId || typeof payload.expiresAt !== "number") {
    return { valid: false, reason: "malformed" };
  }
  if (Date.now() > payload.expiresAt) return { valid: false, reason: "expired" };

  return { valid: true, payload };
}

/** Opaque, unguessable identifier for submit tokens and lease ids. */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
