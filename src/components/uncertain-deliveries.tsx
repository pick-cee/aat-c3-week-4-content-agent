import { serviceClient, table } from "@/lib/db/client";
import { CHANNEL_LABELS, formatWhen } from "./status";

/**
 * Deliveries whose outcome nobody knows. DESIGN.md §15.5.
 *
 * "An automated system that cannot tell whether it did something must ask, not
 * guess." These rows are the asking: the provider never responded, the send
 * will not be retried automatically, and a person has to decide.
 *
 * The recipient and the provider message id are shown because they are what a
 * human needs to resolve it — checking a Resend dashboard by message id, or
 * asking the one subscriber whether the email arrived.
 *
 * The handle is MASKED. Contact details are the most sensitive data here
 * (§19.5b) and this is a screen that ends up in screenshots; the local part is
 * enough to identify which subscriber without printing the address.
 */

interface UncertainRow {
  id: string;
  queue_id: string;
  channel: string;
  provider_message_id: string | null;
  error_text: string | null;
  created_at: string;
  handle: string | null;
}

export async function UncertainDeliveries({ requestId }: { requestId?: string }) {
  const rows = await loadUncertain(requestId);
  if (rows.length === 0) return null;

  return (
    <div className="card mb-3" style={{ borderColor: "#fecaca" }}>
      <div className="card-head" style={{ background: "var(--danger-soft)" }}>
        <h2 style={{ fontSize: 15, color: "var(--danger)" }}>
          {rows.length} {rows.length === 1 ? "delivery" : "deliveries"} with an unknown outcome
        </h2>
        <span className="tiny" style={{ color: "var(--danger)" }}>
          Not retried automatically
        </span>
      </div>

      <div className="card-pad">
        <p className="small muted">
          The provider never confirmed these. They may have arrived or they may not, so the
          system will not re-send them — doing that is how one person receives the same message
          twice. Check the provider by message id, or ask the recipient.
        </p>

        <table>
          <thead>
            <tr>
              <th>Recipient</th>
              <th>Channel</th>
              <th>Provider message id</th>
              <th>Since</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="small">{maskHandle(row.handle)}</td>
                <td className="small">
                  {CHANNEL_LABELS[row.channel as keyof typeof CHANNEL_LABELS] ?? row.channel}
                </td>
                <td className="tiny mono">
                  {row.provider_message_id ?? (
                    <span
                      className="dim"
                      title="No identifier came back, so there is nothing to look up. The recipient is the only way to confirm."
                    >
                      none returned
                    </span>
                  )}
                </td>
                <td className="tiny dim nowrap">{formatWhen(row.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * `a***@example.com`. Enough to tell subscribers apart without putting an
 * address on a screen that gets screenshotted (§19.5b).
 */
function maskHandle(handle: string | null): string {
  if (!handle) return "—";
  const at = handle.indexOf("@");
  if (at <= 0) return `${handle.slice(0, 1)}***`;
  return `${handle.slice(0, 1)}***${handle.slice(at)}`;
}

async function loadUncertain(requestId?: string): Promise<UncertainRow[]> {
  try {
    const db = serviceClient();

    let query = db
      .from(table("publish_deliveries"))
      .select("id, queue_id, channel, provider_message_id, error_text, created_at, recipient_id")
      .eq("status", "uncertain")
      .order("created_at", { ascending: false })
      .limit(50);

    // On a request page, only that request's deliveries; on the dashboard, all.
    if (requestId) {
      const { data: queueIds } = await db
        .from(table("publish_queue"))
        .select("id")
        .eq("request_id", requestId);

      const ids = (queueIds ?? []).map((q) => q.id as string);
      if (ids.length === 0) return [];
      query = query.in("queue_id", ids);
    }

    const { data, error } = await query;
    if (error || !data || data.length === 0) return [];

    // The handle lives on `recipients`; joining keeps it to one round trip.
    const { data: recipients } = await db
      .from(table("recipients"))
      .select("id, handle")
      .in("id", data.map((d) => d.recipient_id as string));

    const handles = new Map(
      (recipients ?? []).map((r) => [r.id as string, r.handle as string]),
    );

    return data.map((row) => ({
      id: row.id as string,
      queue_id: row.queue_id as string,
      channel: row.channel as string,
      provider_message_id: row.provider_message_id as string | null,
      error_text: row.error_text as string | null,
      created_at: row.created_at as string,
      handle: handles.get(row.recipient_id as string) ?? null,
    }));
  } catch {
    // A panel that cannot load must not take the page with it (§20).
    return [];
  }
}
