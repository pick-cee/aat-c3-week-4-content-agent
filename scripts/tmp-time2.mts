import { config } from "dotenv";
config();
const { runStep } = await import("@/lib/pipeline/runner");
const ID = "81e9412c-8041-4e56-964b-cc97a33dfcd7";
let total = 0;
for (let i = 0; i < 8; i++) {
  const t0 = Date.now();
  const r = await runStep(ID);
  const secs = (Date.now() - t0) / 1000;
  total += secs;
  console.log(`${secs.toFixed(1).padStart(6)}s  ${String(r.step ?? "-").padEnd(10)} ${r.to.padEnd(15)} ${r.message.slice(0, 55)}`);
  if (!r.more) break;
}
console.log(`\ntotal: ${total.toFixed(1)}s`);
