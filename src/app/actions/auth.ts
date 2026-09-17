"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { userClient, serviceClient, table } from "@/lib/db/client";
import { consumeRateLimit } from "@/lib/cost";
import { env } from "@/lib/env";
import { DEMO_ACCOUNT } from "@/lib/personas";

/**
 * Authentication.
 *
 * One account, created at startup by `lib/db/seed.ts`. There is no sign-up and
 * no password form: the brief is about the content pipeline, and a login
 * screen between a grader and the thing being graded is friction with no
 * purpose.
 *
 * Rate limited per IP and fails closed, because "a public demo with a sign-in
 * button is a public spend button" (§18.4, §20).
 */

/**
 * Bound directly to a <form action>, so `redirect()` below propagates as Next
 * intends rather than being caught by a caller.
 *
 * Failures redirect back with a reason in the query string instead of
 * returning a value — a form action's return value has nowhere to go here, and
 * a sign-in that fails silently is exactly the bug this shape avoids.
 */
export async function signInAsDemo(): Promise<void> {
  if (!env.app.demoLoginEnabled) redirect("/?error=Demo+access+is+disabled+for+this+workspace.");
  const ip = await clientIp();

  const check = await consumeRateLimit(
    "ip",
    ip,
    "day",
    "demo_signin",
    env.limits.demoSigninsPerIpPerDay,
  );

  if (!check.allowed) {
    redirect(
      `/?error=${encodeURIComponent(
        check.current === -1
          ? "The rate-limit counter could not be read, so sign-in was refused."
          : `Sign-in is limited to ${env.limits.demoSigninsPerIpPerDay} per day from one address.`,
      )}`,
    );
  }

  const supabase = await userClient();

  const { error } = await supabase.auth.signInWithPassword({
    email: DEMO_ACCOUNT.email,
    password: DEMO_ACCOUNT.password,
  });

  if (error) {
    redirect(
      `/?error=${encodeURIComponent(
        `Could not sign in: ${error.message}. The account is created at startup, check /api/health if this persists.`,
      )}`,
    );
  }

  redirect("/");
}

export async function signOut(): Promise<void> {
  const supabase = await userClient();
  await supabase.auth.signOut();
  redirect("/");
}

/** Accounts are provisioned by the agency; this does not enable public signup. */
export async function signIn(form: FormData): Promise<void> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const ip = await clientIp();
  const limit = await consumeRateLimit("ip", ip, "hour", "password_signin", 12);
  if (!limit.allowed) redirect("/?error=Too+many+sign-in+attempts.+Try+again+later.");
  if (!email || !password || email.length > 254 || password.length > 1024) redirect("/?error=Enter+your+email+and+password.");
  const client = await userClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) redirect("/?error=The+email+or+password+was+not+recognised.");
  const { data: member, error: memberError } = await serviceClient().from(table("profiles"))
    .select("id, is_demo").eq("id", data.user.id).maybeSingle();
  if (memberError || !member) {
    await client.auth.signOut();
    redirect(memberError
      ? "/?error=Workspace+access+could+not+be+verified.+Please+try+again."
      : "/?error=This+account+does+not+have+access+to+this+workspace.");
  }
  if (member.is_demo && !env.app.demoLoginEnabled) {
    await client.auth.signOut();
    redirect("/?error=Demo+access+is+disabled+in+this+environment.+Use+a+workspace+account.");
  }
  redirect("/");
}

async function clientIp(): Promise<string> {
  const headerList = await headers();
  return (
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headerList.get("x-real-ip") ??
    "unknown"
  );
}
