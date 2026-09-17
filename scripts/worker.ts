import "dotenv/config";
import { runStep } from "../src/lib/pipeline/runner";
import { runRelease } from "../src/lib/publish/worker";
import { serviceClient, table } from "../src/lib/db/client";

// Run under a process supervisor. Multiple workers share atomic DB claims.
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const createdAfter = process.env.WORKER_CREATED_AFTER;
if (createdAfter && !Number.isFinite(Date.parse(createdAfter))) throw new Error("WORKER_CREATED_AFTER must be an ISO date.");

async function nextRequest() {
  if (!createdAfter) return undefined;
  const now = new Date().toISOString();
  const { data, error } = await serviceClient().from(table("content_requests")).select("id")
    .gte("created_at", createdAfter).is("deleted_at", null)
    .in("status", ["researching", "drafting", "evaluating", "revising", "adapting"])
    .or("runner_lease_until.is.null,runner_lease_until.lt." + now)
    .or("retry_after.is.null,retry_after.lte." + now)
    .order("updated_at").limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.id ?? null;
}

async function pipeline() {
  while (!stopping) {
    try {
      const requestId = await nextRequest();
      if (requestId === null) { await pause(1_000); continue; }
      const result = await runStep(requestId);
      if (!result.advanced) await pause(1_000);
    } catch (error) {
      console.error("[worker] pipeline", error);
      await pause(3_000);
    }
  }
}
async function releases() {
  while (!stopping) {
    try { await runRelease(); }
    catch (error) { console.error("[worker] releases", error); }
    for (let i = 0; i < 15 && !stopping; i++) await pause(1_000);
  }
}
const contentOnly = process.argv.includes("--content-only");
console.info(`Content worker started${contentOnly ? " (draft preparation only; publishing worker is off)" : ""}. Ctrl+C drains the current work and exits.`);
void Promise.all([pipeline(), ...(contentOnly ? [] : [releases()])]).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
