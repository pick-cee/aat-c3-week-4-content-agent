import "server-only";

/**
 * Node-only startup work, kept out of `instrumentation.ts` so the edge build
 * never traces `pg` and its `fs`/`path` dependencies.
 *
 * Both steps are idempotent and swallow their own failures: a database that is
 * briefly unreachable should delay the first request, not crash the process.
 * `/api/health` reports the real state either way (DESIGN.md §20).
 */
export async function runStartup(): Promise<void> {
  // Deployment normally applies migrations; local startup can explicitly opt in.
  if (process.env.AUTO_MIGRATE !== "true") return;
  const { ensureSchema } = await import("./migrate");
  const { seedIfEmpty } = await import("./seed");

  await ensureSchema();
  await seedIfEmpty();

  // A separate `npm run worker` process drives research and publishing.
}
