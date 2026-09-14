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

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

async function main() {
  // Imported after dotenv so the modules see a populated environment.
  const planning = await import("../src/lib/pipeline/planning");
  const drafting = await import("../src/lib/pipeline/drafting");
  const adaptation = await import("../src/lib/pipeline/adaptation");
  const evaluation = await import("../src/lib/pipeline/evaluation");

  const schemas: { name: string; schema: unknown }[] = [
    { name: "planning: angles", schema: planning.ANGLE_SCHEMA },
    { name: "drafting: article header", schema: drafting.HEADER_SCHEMA },
    { name: "adaptation: linkedin", schema: adaptation.LINKEDIN_SCHEMA },
    { name: "adaptation: x", schema: adaptation.X_SCHEMA },
    { name: "adaptation: newsletter", schema: adaptation.NEWSLETTER_SCHEMA },
    { name: "evaluation: judged rubric", schema: evaluation.JUDGED_SCHEMA },
    { name: "images: alt text", schema: (await import("../src/lib/pipeline/images")).ALT_SCHEMA },
  ];

  let bad = 0;

  for (const { name, schema } of schemas) {
    try {
      await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16,
        messages: [{ role: "user", content: "ok" }],
        output_config: { format: { type: "json_schema", schema: schema as never } },
      });
      console.log(`  OK   ${name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A refusal about the SCHEMA is the failure we are hunting. Anything
      // else (a token limit from max_tokens: 16, say) means the schema was
      // accepted and the call merely did not finish.
      if (/output_config\.format\.schema/.test(message)) {
        bad++;
        console.log(`  FAIL ${name}`);
        console.log(`       ${message.slice(0, 220)}`);
      } else {
        console.log(`  OK   ${name} (schema accepted)`);
      }
    }
  }

  console.log(`\nchecked ${schemas.length} schemas; ${bad} rejected by the API`);
  if (bad > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
