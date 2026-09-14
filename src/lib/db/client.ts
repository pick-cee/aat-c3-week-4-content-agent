import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import type { Database } from "./types";

/**
 * Two clients, and the distinction is a security boundary.
 *
 *   · `serviceClient()` bypasses RLS. Every write that matters goes through it,
 *     inside a server action or route handler that has already checked the
 *     caller's role. It must never be constructed in anything a client
 *     component can reach — `server-only` makes that a build error.
 *
 *   · `userClient()` carries the signed-in user's session and is subject to
 *     RLS. Used for reads on behalf of a person.
 *
 * DESIGN.md §19.1, §19.4.
 */

/**
 * Every table this build owns lives in the `content_agent` schema, so it
 * cannot collide with the other application already in this Supabase project
 * (see supabase/migrations/0001_schema.sql).
 *
 * PostgREST will not serve a schema that is not on Supabase's platform
 * allowlist, which is a dashboard setting rather than anything a migration can
 * grant. So each table is also exposed through `public` as a `ca_`-prefixed
 * auto-updatable view (0005), and the client talks to those.
 *
 * `table()` is the single place that knows about the prefix. Call sites say
 * `.from(table("sources"))` and stay readable.
 */
const TABLE_PREFIX = "ca_";

/**
 * The logical names, as the schema and DESIGN.md use them. Derived by
 * stripping the prefix off the generated keys, so adding a table to
 * `Database` makes it available here automatically and a name that does not
 * exist will not compile.
 */
type Unprefixed<T> = T extends `${typeof TABLE_PREFIX}${infer Name}` ? Name : never;

export type TableName = Unprefixed<
  keyof Database["public"]["Tables"] | keyof Database["public"]["Views"]
>;

/**
 * Returns the prefixed literal type, not a widened `string`, so
 * `.from(table("sources"))` still resolves to the typed row and a typo is a
 * compile error rather than a runtime 404.
 */
export function table<T extends TableName>(name: T): `${typeof TABLE_PREFIX}${T}` {
  return `${TABLE_PREFIX}${name}`;
}

let cachedService: SupabaseClient<Database> | null = null;

export function serviceClient(): SupabaseClient<Database> {
  cachedService ??= createClient<Database>(env.supabase.url, env.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-application": "koya-content-agent" } },
  });
  return cachedService;
}

/** Session-scoped client for server components and actions. RLS applies. */
export async function userClient(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies();

  return createServerClient<Database>(env.supabase.url, env.supabase.anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (items) => {
        try {
          for (const { name, value, options } of items) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a server component, where cookies are read-only.
          // Session refresh is handled in middleware; this is the documented
          // no-op path from @supabase/ssr.
        }
      },
    },
  });
}

/**
 * The signed-in profile, or null. Every server action that mutates starts here
 * — the UI is not a security boundary (DESIGN.md §14.3).
 */
export async function currentProfile() {
  const supabase = await userClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Read through the service client: a profile row is needed to evaluate role,
  // and reading it through RLS that itself depends on the profile row is a
  // circularity that bites the first time someone tightens a policy.
  const { data, error } = await serviceClient()
    .from(table("profiles"))
    .select("id, email, full_name, role, is_demo")
    .eq("id", user.id)
    .maybeSingle();

  // A query error and a genuinely absent row both used to return null here,
  // which meant a signed-in user looked signed-out with no explanation — a
  // misspelled column in the select list silently logged everyone out. Unknown
  // is not zero (§17): if the lookup FAILED, say so rather than quietly
  // treating the person as anonymous.
  if (error) {
    console.error(
      `[auth] could not read the profile for ${user.id}: ${error.message}. ` +
        `Treating as signed out, which is probably not what you want.`,
    );
    return null;
  }

  return data ?? null;
}

export type CurrentProfile = NonNullable<Awaited<ReturnType<typeof currentProfile>>>;

/** Reviewer or admin. The roles that may approve and schedule (DESIGN.md §4). */
export function canApprove(profile: { role: string } | null): boolean {
  return profile?.role === "reviewer" || profile?.role === "admin";
}

/** Connecting an account grants the system the ability to post as a real person. */
export function isAdmin(profile: { role: string } | null): boolean {
  return profile?.role === "admin";
}
