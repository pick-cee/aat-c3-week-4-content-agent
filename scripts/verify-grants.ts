/**
 * Fails if any function is executable by a role that should not have it.
 *
 * This is a STANDING check, not a one-time audit. Postgres grants EXECUTE to
 * PUBLIC by default on every function it creates, so the hole 0007 closed is
 * one `create function` away from reopening — and it reopens silently, because
 * adding a grant is visible in a migration while inheriting one is not.
 *
 * What it caught the first time, against the live project:
 *
 *   claim_due_publish_item  HTTP 200 to the anon key that ships in the browser
 *   bump_counter            HTTP 200, so rate limits were burnable by anyone
 *   sweep_stuck_publishing  HTTP 200, so queued posts could be forced to
 *                           `uncertain` and never go out
 *
 * Usage: npm run verify:grants
 */
import { config } from "dotenv";
config({ quiet: true });

import pg from "pg";

/** The only functions a signed-in person may call directly. Both are reads. */
const AUTHENTICATED_ALLOWED = new Set(["read_counter", "dashboard_counts"]);

/**
 * Called BY the RLS policies in 0002, evaluated as the querying role, so that
 * role must be able to execute them. They read the caller's own profile row and
 * return a boolean.
 */
const RLS_HELPERS = new Set(["current_role_is", "can_approve", "is_signed_in"]);

const FORBIDDEN_ROLES = ["PUBLIC", "public", "anon"];

export interface GrantCheckResult {
  functionCount: number;
  problems: string[];
}

/**
 * Exported so the broken-input pack can run this in-process. Shelling out to
 * `npx` from there fails on Windows with EINVAL, and a check that cannot run
 * on the machine doing the testing is not a check.
 */
export async function checkGrants(): Promise<GrantCheckResult> {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_URL!,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
  });

  await client.connect();

  /**
   * Only the functions THIS BUILD created.
   *
   * `public` also holds pgvector's and pgcrypto's functions, which Supabase
   * installs and which are executable by PUBLIC by design — flagging
   * `array_to_halfvec` buries the one row that matters under three hundred
   * that do not. `pg_depend` identifies anything owned by an extension.
   *
   * DISTINCT because a function with several overloads appears once per
   * signature, and the grant is the same on each.
   */
  const { rows } = await client.query<{
    schema: string;
    name: string;
    grantee: string;
  }>(`
    select distinct
           n.nspname as schema,
           p.proname as name,
           coalesce(a.grantee, 'PUBLIC') as grantee
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      left join lateral (
        select case
                 when (x).grantee = 0 then 'PUBLIC'
                 else pg_get_userbyid((x).grantee)
               end as grantee
          from (select (aclexplode(p.proacl)).*) as x
         where (x).privilege_type = 'EXECUTE'
      ) a on true
     where n.nspname in ('public', 'content_agent')
       and p.prokind = 'f'
       -- A null ACL means the DEFAULT applies, which is EXECUTE to PUBLIC.
       and (p.proacl is null or a.grantee is not null)
       -- Not ours: pgvector, pgcrypto and friends.
       and not exists (
         select 1 from pg_depend d
          where d.objid = p.oid
            and d.deptype = 'e'
       )
     order by 1, 2, 3
  `);

  const problems: string[] = [];

  for (const row of rows) {
    const isRlsHelper = RLS_HELPERS.has(row.name);

    if (FORBIDDEN_ROLES.includes(row.grantee)) {
      // The RLS helpers legitimately need anon; nothing else does.
      if (isRlsHelper && row.grantee === "anon") continue;
      problems.push(
        `${row.schema}.${row.name} is executable by ${row.grantee}` +
          (row.grantee === "PUBLIC"
            ? " — this is the Postgres default, so the function was created without a REVOKE"
            : ""),
      );
      continue;
    }

    if (
      row.grantee === "authenticated" &&
      !AUTHENTICATED_ALLOWED.has(row.name) &&
      !isRlsHelper
    ) {
      problems.push(
        `${row.schema}.${row.name} is executable by authenticated, which may only call ` +
          `${[...AUTHENTICATED_ALLOWED].join(" and ")}`,
      );
    }
  }

  await client.end();

  return {
    functionCount: new Set(rows.map((r) => `${r.schema}.${r.name}`)).size,
    problems,
  };
}

async function main() {
  const { functionCount, problems } = await checkGrants();

  if (problems.length > 0) {
    console.log(`  ${problems.length} function(s) are callable by a role that should not:`);
    for (const problem of problems) console.log(`    FAIL ${problem}`);
    console.log(
      `\nchecked ${functionCount} functions; ${problems.length} over-granted\n` +
        `Fix with an explicit REVOKE, and check ALTER DEFAULT PRIVILEGES covers the schema.`,
    );
    process.exit(1);
  }

  console.log(`checked ${functionCount} functions; 0 over-granted`);
}

// Only when run directly, so importing `checkGrants` does not exit the caller.
if (process.argv[1]?.includes("verify-grants")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
