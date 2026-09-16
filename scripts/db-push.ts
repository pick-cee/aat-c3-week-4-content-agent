/**
 * Applies supabase/migrations/*.sql in filename order.
 *
 * Each file runs inside a transaction and is recorded in the tracking table,
 * so re-running is safe and only pending files execute. Every migration is
 * also written to be idempotent on its own (`if not exists`, `or replace`),
 * because the two mechanisms protect against different mistakes.
 *
 * This is the same ledger and the same advisory lock that src/lib/db/migrate.ts
 * uses at startup — deliberately, because two runners with two ledgers is two
 * different opinions about what the schema is. It previously wrote to
 * `public.schema_migrations`, which another application on this database
 * already owns with a different column layout, so every run of this script
 * failed with `column "filename" does not exist` while the app's own startup
 * path worked fine.
 *
 * Usage: npm run db:push [-- --force]
 *   --force re-runs every migration, including already-applied ones.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { Client } from "pg";

config();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "supabase", "migrations");
const force = process.argv.includes("--force");

/** Must match src/lib/db/migrate.ts exactly — one ledger, one lock. */
const TRACKING_TABLE = "_content_agent_migrations";
const ADVISORY_LOCK_KEY = 4_872_311_904;

async function main() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    console.error(
      "\n  SUPABASE_DB_URL is not set.\n\n" +
        "  Supabase dashboard → Project Settings → Database → Connection string → URI\n" +
        "  Paste it into .env as SUPABASE_DB_URL.\n",
    );
    process.exit(1);
  }

  const client = new Client({
    connectionString,
    // Supabase's pooler presents a certificate chain Node does not bundle.
    // This is a direct admin connection from a developer machine to a known
    // host, not a browser trusting an unknown server.
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("Connected.\n");

  // Blocks if the app is cold-starting and applying the same files right now.
  await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);

  await client.query(`
    create table if not exists ${TRACKING_TABLE} (
      filename    text primary key,
      checksum    text,
      applied_at  timestamptz not null default now()
    );
  `);

  const applied = new Set(
    force
      ? []
      : (await client.query<{ filename: string }>(`select filename from ${TRACKING_TABLE}`))
          .rows.map((r) => r.filename),
  );

  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  let ran = 0;

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file} (already applied)`);
      continue;
    }

    const sql = readFileSync(join(migrationsDir, file), "utf8");
    process.stdout.write(`  run   ${file} ... `);

    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(
        `insert into ${TRACKING_TABLE} (filename) values ($1)
         on conflict (filename) do update set applied_at = now()`,
        [file],
      );
      await client.query("commit");
      console.log("ok");
      ran++;
    } catch (err) {
      await client.query("rollback");
      console.log("FAILED\n");
      // Print the whole error. A migration that fails with a truncated message
      // is a migration you debug twice.
      console.error(err);
      await client.query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
      await client.end();
      process.exit(1);
    }
  }

  await client.query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
  await client.end();
  console.log(
    ran === 0
      ? "\nNothing to do — schema is up to date.\n"
      : `\n${ran} migration${ran === 1 ? "" : "s"} applied.\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
