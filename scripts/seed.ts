/**
 * Seeds the demo account, the brand voice, the connector rows and the demo
 * recipients.
 *
 * The seed itself lives at `src/lib/db/seed.ts` and runs automatically at app
 * startup. This is the manual entry point: `package.json` pointed here for a
 * file that did not exist, so `npm run db:seed` failed on a fresh clone.
 *
 * Idempotent — running it against a populated database changes nothing except
 * re-asserting the demo account's role.
 *
 * Usage: npm run db:seed
 */
import { config } from "dotenv";
config({ quiet: true });

async function main() {
  // Imported after dotenv, so the module sees a populated environment.
  const { runMigrations } = await import("../src/lib/db/migrate");
  const { seedIfEmpty } = await import("../src/lib/db/seed");

  // Seeding a database with no schema fails in a confusing way, so the
  // migrations run first. Both are idempotent.
  const migrations = await runMigrations();
  console.log(
    migrations.applied.length > 0
      ? `Applied ${migrations.applied.length} migration(s): ${migrations.applied.join(", ")}`
      : `Schema is up to date (${migrations.skipped.length} migrations already applied).`,
  );

  await seedIfEmpty();
  console.log("Seed complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
