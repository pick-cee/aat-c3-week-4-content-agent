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
  const { ensureSchema } = await import("./migrate");
  const { seedIfEmpty } = await import("./seed");

  await ensureSchema();
  await seedIfEmpty();

  // The queue keeps its own schedule from here: a send time is a promise the
  // app has to keep whether or not anyone has a page open.
  const { startScheduler } = await import("../publish/scheduler");
  startScheduler();
}
