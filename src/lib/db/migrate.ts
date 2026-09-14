import "server-only";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Migrations run on app startup, once, automatically.
 *
 * Nobody runs a CLI against a deployed app on grading day, so the schema has to
 * bring itself up. Three things make that safe to call on every boot:
 *
 *   1. A Postgres advisory lock, so two cold-starting serverless instances
 *      cannot apply the same migration concurrently. The second waits, then
 *      finds the work already recorded and does nothing.
 *   2. A tracking table recording what has been applied. Supabase already owns
 *      `schema_migrations` for its own purposes, hence the distinct name —
 *      writing to a table another system manages is how you lose a database.
 *   3. Each migration file is independently idempotent (`if not exists`,
 *      `create or replace`), so even a forced re-run is harmless.
 *
 * The in-process promise means concurrent callers within one instance share a
 * single run rather than queuing behind each other on the lock.
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const TRACKING_TABLE = "_content_agent_migrations";

/** Arbitrary but fixed: the same number must be used by every instance. */
const ADVISORY_LOCK_KEY = 4_872_311_904;

export type MigrationResult = {
  applied: string[];
  skipped: string[];
  alreadyCurrent: boolean;
};

let inFlight: Promise<MigrationResult> | null = null;

export function runMigrations(): Promise<MigrationResult> {
  inFlight ??= execute().catch((err) => {
    // Clear the memo so a transient failure (a database still waking up) can
    // be retried by the next request rather than poisoning the process.
    inFlight = null;
    throw err;
  });
  return inFlight;
}

async function execute(): Promise<MigrationResult> {
  // Reached only from startup.ts, which instrumentation.ts imports inside its
  // `nodejs` branch — so this module is never part of the edge build and `pg`
  // resolves normally.
  const { Client } = await import("pg");

  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error(
      "SUPABASE_DB_URL is not set, so the schema cannot be created. " +
        "Supabase dashboard → Project Settings → Database → Connection string → URI.",
    );
  }

  const client = new Client({
    connectionString,
    // A direct admin connection from the server to a known Supabase host.
    // The pooler presents a chain Node does not bundle.
    ssl: { rejectUnauthorized: false },
    statement_timeout: 120_000,
  });

  await client.connect();

  try {
    // Blocks until any other instance finishes. Released with the session.
    await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);

    await client.query(`
      create table if not exists ${TRACKING_TABLE} (
        filename   text primary key,
        checksum   text,
        applied_at timestamptz not null default now()
      );
    `);

    const { rows } = await client.query<{ filename: string }>(
      `select filename from ${TRACKING_TABLE}`,
    );
    const done = new Set(rows.map((r) => r.filename));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      if (done.has(file)) {
        skipped.push(file);
        continue;
      }

      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

      try {
        await client.query("begin");
        await client.query(sql);
        await client.query(
          `insert into ${TRACKING_TABLE} (filename) values ($1)
             on conflict (filename) do update set applied_at = now()`,
          [file],
        );
        await client.query("commit");
        applied.push(file);
      } catch (err) {
        await client.query("rollback").catch(() => {});
        // Name the file. A migration failure with no filename is a migration
        // failure you debug twice.
        throw new Error(
          `Migration ${file} failed and was rolled back: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    }

    return { applied, skipped, alreadyCurrent: applied.length === 0 };
  } finally {
    // Unlock explicitly so a pooled connection does not hold it, then close.
    await client.query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
    await client.end().catch(() => {});
  }
}

/**
 * Best-effort startup call. Logs and swallows, because a migration failure
 * should surface at /api/health with a real diagnosis rather than turning
 * every page into a stack trace (DESIGN.md §20: a dead dependency must be
 * diagnosable, and the app must still render).
 */
export async function ensureSchema(): Promise<MigrationResult | null> {
  try {
    const result = await runMigrations();
    if (result.applied.length > 0) {
      console.log(`[schema] applied: ${result.applied.join(", ")}`);
    }
    return result;
  } catch (err) {
    console.error("[schema] migration failed:", err);
    return null;
  }
}
