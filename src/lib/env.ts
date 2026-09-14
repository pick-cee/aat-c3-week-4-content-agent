import "server-only";

/**
 * Server-side environment access.
 *
 * DESIGN.md §19.1: no key reaches the browser. Importing `server-only` makes
 * that a build error rather than a code review note — a client component that
 * imports this file fails to compile.
 *
 * Values are read lazily, not at module load. A missing Firecrawl key should
 * break the fetch step with a clear message, not prevent the dashboard from
 * rendering. DESIGN.md §20: "a connector being disconnected must degrade the
 * app, not break it."
 */

/** Thrown when a required key is absent. Carries the name so the fix is obvious. */
export class MissingEnvError extends Error {
  constructor(public readonly key: string) {
    super(
      `Missing required environment variable ${key}. ` +
        `Add it to .env — see .env.example for what it is and where to get it.`,
    );
    this.name = "MissingEnvError";
  }
}

function required(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === "") throw new MissingEnvError(key);
  return value.trim();
}

function optional(key: string, fallback = ""): string {
  return process.env[key]?.trim() || fallback;
}

function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  // A malformed number in config is a mistake worth surfacing, not one to
  // paper over with a default that silently differs from what was written.
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${key} must be an integer, got "${raw}".`);
  }
  return parsed;
}

/** Strips surrounding quotes, which .env files commonly carry on display names. */
function unquote(value: string): string {
  return value.replace(/^["'](.*)["']$/s, "$1");
}

export const env = {
  supabase: {
    get url() {
      return required("NEXT_PUBLIC_SUPABASE_URL");
    },
    get anonKey() {
      return required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    },
    /** Bypasses RLS. Server-side only, always. */
    get serviceRoleKey() {
      return required("SUPABASE_SERVICE_ROLE_KEY");
    },
    /** Migrations only. */
    get dbUrl() {
      return required("SUPABASE_DB_URL");
    },
  },

  anthropic: {
    get apiKey() {
      return required("ANTHROPIC_API_KEY");
    },
  },

  firecrawl: {
    get apiKey() {
      return required("FIRECRAWL_API_KEY");
    },
    get configured() {
      return Boolean(optional("FIRECRAWL_API_KEY"));
    },
  },

  voyage: {
    get apiKey() {
      return required("VOYAGE_API_KEY");
    },
    get configured() {
      return Boolean(optional("VOYAGE_API_KEY"));
    },
  },

  resend: {
    get apiKey() {
      return required("RESEND_API_KEY");
    },
    get from() {
      return unquote(optional("RESEND_FROM_EMAIL", "onboarding@resend.dev"));
    },
    get replyTo() {
      return optional("RESEND_REPLY_TO");
    },
    get configured() {
      return Boolean(optional("RESEND_API_KEY"));
    },
  },

  openverse: {
    get clientId() {
      return optional("OPENVERSE_CLIENT_ID");
    },
    get clientSecret() {
      return optional("OPENVERSE_CLIENT_SECRET");
    },
  },

  secrets: {
    /** 64 hex chars = 32 bytes for AES-256-GCM. Validated in crypto.ts. */
    get tokenEncryptionKey() {
      return required("TOKEN_ENCRYPTION_KEY");
    },
    get cronSecret() {
      return required("CRON_SECRET");
    },
    get handoffTokenSecret() {
      return required("HANDOFF_TOKEN_SECRET");
    },
  },

  app: {
    get url() {
      return optional("NEXT_PUBLIC_APP_URL", "http://localhost:3000").replace(/\/$/, "");
    },
    /**
     * Defaults to TRUE when unset. Sending real messages should require saying
     * so, not forgetting to. DESIGN.md §19.6.
     */
    get demoMode() {
      return optional("DEMO_MODE", "true").toLowerCase() !== "false";
    },
    get demoRedirectEmail() {
      return optional("DEMO_REDIRECT_EMAIL");
    },
    get handoffPosterEmail() {
      return optional("HANDOFF_POSTER_EMAIL");
    },
  },

  limits: {
    get defaultBudgetCents() {
      return optionalInt("DEFAULT_REQUEST_BUDGET_CENTS", 150);
    },
    get monthlyCapCents() {
      return optionalInt("MONTHLY_GLOBAL_CAP_CENTS", 5_000);
    },
    get demoBudgetCents() {
      return optionalInt("DEMO_WORKSPACE_BUDGET_CENTS", 60);
    },
    get requestsPerHour() {
      return optionalInt("RATE_LIMIT_REQUESTS_PER_HOUR", 10);
    },
    get requestsPerDay() {
      return optionalInt("RATE_LIMIT_REQUESTS_PER_DAY", 40);
    },
    get demoSigninsPerIpPerDay() {
      return optionalInt("RATE_LIMIT_DEMO_SIGNINS_PER_IP_PER_DAY", 200);
    },
  },
} as const;

/**
 * Which optional integrations are configured. Drives /api/health and the
 * connector banners, so a dead dependency is diagnosable without reading logs
 * (DESIGN.md §20) and every screen still renders with connectors empty.
 */
export function integrationStatus() {
  return {
    firecrawl: env.firecrawl.configured,
    voyage: env.voyage.configured,
    resend: env.resend.configured,
    openverse: true, // Works anonymously, at a lower rate limit.
    demoMode: env.app.demoMode,
  };
}
