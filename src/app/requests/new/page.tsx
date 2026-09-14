import { redirect } from "next/navigation";
import { currentProfile, serviceClient, table } from "@/lib/db/client";
import { randomToken } from "@/lib/crypto";
import { env } from "@/lib/env";
import { NewRequestForm } from "./form";
import type { BrandVoice } from "@/lib/db/types";

/** Intake. DESIGN.md §6. */

export const dynamic = "force-dynamic";

export default async function NewRequestPage() {
  const profile = await currentProfile();
  if (!profile) redirect("/");

  const { data } = await serviceClient()
    .from(table("brand_voices"))
    .select("*")
    .order("is_default", { ascending: false });

  const voices = (data ?? []) as unknown as BrandVoice[];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>New content request</h1>
          <p>
            An idea, a URL, or both. You will confirm the sources and pick an angle before
            anything is written.
          </p>
        </div>
      </div>

      <NewRequestForm
        voices={voices.map((v) => ({
          id: v.id,
          name: v.name,
          audienceDefault: v.audience_default,
          isDefault: v.is_default,
        }))}
        defaultBudgetCents={
          profile.is_demo ? env.limits.demoBudgetCents : env.limits.defaultBudgetCents
        }
        // Generated server-side per render, so a double-click submits the same
        // token twice and the unique constraint makes one request (§5.3).
        submitToken={randomToken(16)}
        isDemo={profile.is_demo}
      />
    </>
  );
}
