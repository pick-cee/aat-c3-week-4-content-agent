import "server-only";
import { runStep } from "./runner";

/** The database is the durable queue; leave room for the last unit to finish. */
export async function drainPipeline(requestId?: string, startBudgetMs = 60_000) {
  const started = Date.now();
  let steps = 0;
  while (Date.now() - started < startBudgetMs && steps < 40) {
    const result = await runStep(requestId);
    if (!result.advanced) break;
    steps++;
    if (result.attempt || (!result.more && requestId)) break;
  }
  return { steps };
}
