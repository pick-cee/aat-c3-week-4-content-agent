/**
 * Sends every structured-output schema in the pipeline to the real API.
 *
 * Exists because the API rejects several JSON Schema keywords that are
 * perfectly valid JSON Schema — `minItems` above 1, `maxItems` at all,
 * `minimum`/`maximum` on numbers — and it only says so at CALL time. That
 * meant a schema mistake surfaced three pipeline steps later as a failed
 * request, after real money had been spent on the steps before it.
 *
 * A cheap Haiku call per schema is a much better way to find out.
 *
 * Usage: npm run verify:schemas
 */
import { config } from "dotenv";
config({ quiet: true });

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, maxRetries: 0, timeout: 60_000 });

async function main() {
  // Imported after dotenv so the modules see a populated environment.
  const planning = await import("../src/lib/pipeline/planning");
  const revision = await import("../src/lib/pipeline/revision-patch");
  const { MODELS } = await import("../src/lib/constants");
  const { priceModelCall } = await import("../src/lib/cost");
  const { readUsage } = await import("../src/lib/providers/anthropic");
  const adaptation = await import("../src/lib/pipeline/adaptation");
  const evaluation = await import("../src/lib/pipeline/evaluation");

  const schemas: { name: string; schema: unknown; model?: string }[] = [
    { name: "planning: angles", schema: planning.ANGLE_SCHEMA },
    { name: "revision: section edits", schema: revision.REVISION_SCHEMA, model: MODELS.revision },
    { name: "adaptation: linkedin", schema: adaptation.LINKEDIN_SCHEMA },
    { name: "adaptation: x", schema: adaptation.X_SCHEMA },
    { name: "adaptation: newsletter", schema: adaptation.NEWSLETTER_SCHEMA },
    { name: "evaluation: judged rubric", schema: evaluation.JUDGED_SCHEMA, model: MODELS.evaluation },
  ];

  let bad = 0, costCents = 0;

  for (const { name, schema, model = MODELS.planning } of schemas) {
    try {
      const response = await client.messages.create({
        model, thinking: { type: "disabled" },
        max_tokens: 16,
        messages: [{ role: "user", content: "ok" }],
        output_config: { format: { type: "json_schema", schema: schema as never } },
      });
      costCents += priceModelCall(model, readUsage(response));
      console.log(`  OK   ${name} (${model})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      bad++;
      console.log("  FAIL " + name + ": " + message.slice(0, 220));
    }
  }

  console.log(`\nchecked ${schemas.length} schemas; ${bad} rejected by the API`);
  console.log("Observed verification usage: $" + (costCents / 100).toFixed(4) + ". Failed calls with missing usage may add cost.");
  if (bad > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
