/**
 * Applies supabase/migrations/*.sql in filename order.
 *
 * Each file runs inside a transaction and is recorded in `schema_migrations`,
 * so re-running is safe and only pending files execute. Every migration is
 * also written to be idempotent on its own (`if not exists`, `or replace`),
 * because the two mechanisms protect against different mistakes.
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

  await client.query(`
    create table if not exists schema_migrations (
      filename    text primary key,
      applied_at  timestamptz not null default now()
    );
  `);

  const applied = new Set(
    force
      ? []
      : (await client.query<{ filename: string }>("select filename from schema_migrations"))
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
        `insert into schema_migrations (filename) values ($1)
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
      await client.end();
      process.exit(1);
    }
  }

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
