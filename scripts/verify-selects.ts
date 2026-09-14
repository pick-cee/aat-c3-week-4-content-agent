/**
 * Checks every `.from(table("x")).select("a, b, c")` in the source against the
 * live schema.
 *
 * Exists because a stale column name in a select list fails at RUNTIME with
 * the whole query erroring, and callers that use `data ?? null` turn that into
 * a silent wrong answer. `currentProfile()` selected `phone_e164` after the
 * column was dropped, so every signed-in user rendered as signed out.
 *
 * Usage: npm run verify:selects
 */
import { config } from "dotenv";
config({ quiet: true });

import { createClient } from "@supabase/supabase-js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, acc);
    else if (/\.tsx?$/.test(entry)) acc.push(path);
  }
  return acc;
}

const pattern = /\.from\(table\("(\w+)"\)\)\s*\n?\s*\.select\(\s*\n?\s*"([^"]+)"/g;

// Wrapped in a function rather than using top-level await: this package is
// CommonJS, and tsx cannot emit top-level await into CJS.
async function main() {
  const seen = new Set<string>();
  const checks: { file: string; tbl: string; cols: string }[] = [];

  for (const file of walk("src")) {
    const src = readFileSync(file, "utf8");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(src)) !== null) {
      const tbl = match[1]!;
      const cols = match[2]!;
      // `*` is always valid; embedded resources need their own handling.
      if (cols === "*" || cols.includes("(")) continue;

      const key = `${tbl}::${cols}`;
      if (seen.has(key)) continue;
      seen.add(key);
      checks.push({ file, tbl, cols });
    }
  }

  let bad = 0;

  for (const { file, tbl, cols } of checks) {
    const { error } = await db.from(`ca_${tbl}`).select(cols).limit(1);
    if (error) {
      bad++;
      console.log(`  FAIL ${tbl} :: ${error.message}`);
      console.log(`       ${file}`);
    }
  }

  console.log(`\nchecked ${checks.length} distinct select lists; ${bad} invalid`);
  if (bad > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
