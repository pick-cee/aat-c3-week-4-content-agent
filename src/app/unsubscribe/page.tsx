import { serviceClient, table } from "@/lib/db/client";
import { logInfo } from "@/lib/log";

/**
 * Unsubscribe. DESIGN.md §9c, §19.5b.
 *
 * "Opt-out is immediate and permanent."
 *
 * Deliberately no confirmation step: a person who clicked unsubscribe has
 * already decided, and an extra click between them and stopping the email is
 * how a sender ends up reported as spam. The opt-out is applied on load.
 */

export const dynamic = "force-dynamic";

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; h?: string }>;
}) {
  const { c: rawChannel, h: handle } = await searchParams;

  // Validated rather than cast: this is a query parameter a stranger controls,
  // and it goes straight into a database filter.
  const channel = rawChannel === "newsletter" ? rawChannel : null;

  if (!channel || !handle) {
    return (
      <Shell heading="Nothing to unsubscribe">
        <p className="muted mb-0">This link is missing the details of which subscription to end.</p>
      </Shell>
    );
  }

  let done = false;
  let alreadyDone = false;

  try {
    const db = serviceClient();

    const { data: recipient } = await db
      .from(table("recipients"))
      .select("id, opt_out_at")
      .eq("channel", channel)
      .eq("handle", handle)
      .maybeSingle();

    if (recipient) {
      if (recipient.opt_out_at) {
        alreadyDone = true;
      } else {
        const { error } = await db
          .from(table("recipients"))
          .update({ opt_out_at: new Date().toISOString() })
          .eq("id", recipient.id as string);

        if (!error) {
          done = true;
          // The handle itself is redacted by the logger (§19.5b), so this
          // records that an opt-out happened without writing the address.
          await logInfo("A recipient opted out. They will not be sent to again.", {
            detail: { channel },
          });
        }
      }
    } else {
      // An unknown handle is treated as success. Telling a stranger whether an
      // address is on the list is an information leak, and the outcome they
      // want — no more email — is true either way.
      done = true;
    }
  } catch {
    done = false;
  }

  if (!done && !alreadyDone) {
    return (
      <Shell heading="Something went wrong">
        <p className="muted">
          Your request could not be recorded just now. Reply to any of our emails and we will
          remove you by hand.
        </p>
      </Shell>
    );
  }

  return (
    <Shell heading={alreadyDone ? "You were already unsubscribed" : "You have been unsubscribed"}>
      <p className="muted mb-0">
        {alreadyDone
          ? "There is nothing more to do, you are not on the list."
          : "That takes effect immediately. You will not receive another newsletter from us."}
      </p>
    </Shell>
  );
}

function Shell({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 480, margin: "64px auto" }}>
      <div className="card card-pad">
        <h1 style={{ fontSize: 19, marginBottom: 10 }}>{heading}</h1>
        {children}
      </div>
    </div>
  );
}
