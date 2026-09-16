import { config } from "dotenv";
config();

/**
 * Times every step of one request, end to end.
 *
 * Steps were measured at 166s (evaluate), 142s (revise) and 141s (plan)
 * against a runner route the platform kills at 60s, so this is the check that
 * says whether the pipeline can actually run on Vercel.
 *
 * Usage: npx tsx --require ./scripts/stub-server-only.cjs scripts/time-pipeline.mts <requestId>
 */
const ID = process.argv[2];
if (!ID) {
  console.error("Pass a request id.");
  process.exit(1);
}

const LIMIT_SECS = 60;

const { runStep } = await import("@/lib/pipeline/runner");

let total = 0;
let overLimit = 0;

for (let i = 0; i < 12; i++) {
  const started = Date.now();
  const result = await runStep(ID);
  const secs = (Date.now() - started) / 1000;
  total += secs;

  const flag = secs > LIMIT_SECS ? "  ← OVER THE 60s FUNCTION LIMIT" : "";
  if (secs > LIMIT_SECS) overLimit++;

  console.log(
    `${secs.toFixed(1).padStart(6)}s  ${String(result.step ?? "-").padEnd(10)} ` +
      `${result.to.padEnd(15)} ${result.message.slice(0, 50)}${flag}`,
  );

  if (!result.more) break;
}

console.log(`\ntotal ${total.toFixed(1)}s, ${overLimit} step(s) over the 60s limit`);
