/** Read-only HTTP checks of a running app. Does not execute browser JS or send content. */
import { config } from "dotenv";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { DEMO_ACCOUNT } from "../src/lib/personas";
config({ quiet: true });

async function main() {
  const base = process.env.SMOKE_APP_URL ?? "http://127.0.0.1:3100";
  const demo = process.env.SMOKE_DEMO_LOGIN === "true";
  if (demo) assert(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "Demo smoke checks are local only.");
  let passed = 0;
  async function read(path: string, expectedStatus: number, content?: string, cookie?: string) {
    const response = await fetch(new URL(path, base), { redirect: "manual", headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(45_000) });
    const html = await response.text();
    const streamedRedirect = expectedStatus === 307 && response.status === 200 && html.includes("NEXT_REDIRECT;replace;/;307;");
    assert(response.status === expectedStatus || streamedRedirect, "Unexpected HTTP status for " + path.replace(/[a-f0-9-]{36}/g, "[id]") + ": " + response.status);
    if (content) assert(html.includes(content), "Expected page content is missing: " + content);
    for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "RESEND_API_KEY"]) {
      const secret = process.env[name];
      if (secret && secret.length > 12) assert(!html.includes(secret), "A secret reached rendered HTML");
    }
    passed++;
    return html;
  }
  const landing = await read("/", 200, "Welcome to your studio.");
  await read("/requests/new", 307);
  await read("/api/runner?requestId=00000000-0000-0000-0000-000000000000", 401);
  await read("/api/cron/release", 401);
  await read("/a/nonexistent-smoke-check-article", 404);
  console.log("PASS Anonymous routes, private-page redirect and unauthorised worker access");

  const email = demo ? DEMO_ACCOUNT.email : process.env.SMOKE_EMAIL;
  const password = demo ? DEMO_ACCOUNT.password : process.env.SMOKE_PASSWORD;
  if (email && password) {
    const signInForm = [...landing.matchAll(/<form\b[\s\S]*?<\/form>/g)].find(match => match[0].includes('name="email"'))?.[0];
    const actionId = signInForm?.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
    assert(actionId, "The sign-in form action is missing");
    const body = new FormData();
    body.set(actionId, ""); body.set("email", email); body.set("password", password);
    const signIn = await fetch(base, { method: "POST", body, redirect: "manual", headers: { origin: new URL(base).origin }, signal: AbortSignal.timeout(45_000) });
    assert(signIn.status === 303 && signIn.headers.get("location") === "/" && signIn.headers.has("set-cookie"), "The app's password sign-in did not establish a session");
    passed++;
    const jar = new Map<string, string>();
    const auth = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: entries => entries.forEach(c => jar.set(c.name, c.value)) },
    });
    const { error } = await auth.auth.signInWithPassword({ email, password });
    assert(!error, "Could not authenticate the smoke-test account");
    const cookie = [...jar].map(([name, value]) => name + "=" + value).join("; ");
    try {
      await read("/", 200, "Make room for good content.", cookie);
      await read("/requests/new", 200, "What are we creating?", cookie);
      await read("/queue", 200, "Publishing queue", cookie);
      await read("/settings", 200, "Settings", cookie);
      await read("/recycle-bin", 200, "Recycle bin", cookie);
      const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data: requests, error: queryError } = await db.from("ca_content_requests").select("id, slug, status").is("deleted_at", null).order("created_at", { ascending: false }).limit(15);
      assert(!queryError, "Could not read a request for the detail smoke check");
      if (requests?.[0]) await read("/requests/" + requests[0].id, 200, "SPEND / LIMIT", cookie);
      const privateArticle = requests?.find(r => r.slug && !["scheduled", "publishing", "published"].includes(r.status));
      if (privateArticle) await read("/a/" + privateArticle.slug, 404);
      console.log("PASS Authenticated workspace, creation, queue, settings, recycle bin and available article routes");
    } finally { await auth.auth.signOut({ scope: "local" }); }
  } else console.log("Authenticated checks skipped: set SMOKE_EMAIL/SMOKE_PASSWORD or opt into local SMOKE_DEMO_LOGIN.");
  console.log(passed + " server-rendering checks passed. Visual layout and client interactions require a browser.");
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Smoke check failed"); process.exitCode = 1; });
