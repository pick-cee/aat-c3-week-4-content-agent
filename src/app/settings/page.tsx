import { redirect } from "next/navigation";
import { currentProfile, serviceClient, isAdmin, table } from "@/lib/db/client";
import { ConnectorStatusPill, CHANNEL_LABELS, Cost, formatWhen } from "@/components/status";
import { SignOutButton } from "./sign-out";
import { env } from "@/lib/env";
import { PRICES_VERIFIED_ON, MODELS } from "@/lib/constants";
import type { BrandVoice, ConnectorStatusRow, Recipient } from "@/lib/db/types";

/**
 * Settings: connectors, the brand voice, recipients and spend.
 *
 * Connector tokens are never selected here — the page reads the
 * `connector_view` view, which excludes the ciphertext columns entirely
 * (§19.2).
 */

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const profile = await currentProfile();
  if (!profile) redirect("/");

  const db = serviceClient();

  const [connectorResult, voiceResult, recipientResult, spendResult] = await Promise.all([
    db.from(table("connector_view")).select("*"),
    db.from(table("brand_voices")).select("*").order("is_default", { ascending: false }),
    db.from(table("recipients")).select("id, channel, opted_in_at, opt_out_at"),
    db
      .from(table("model_calls"))
      .select("model, cost_cents, outcome")
      .gte("created_at", new Date(Date.now() - 30 * 86_400_000).toISOString()),
  ]);

  const connectors = (connectorResult.data ?? []) as unknown as ConnectorStatusRow[];
  const voices = (voiceResult.data ?? []) as unknown as BrandVoice[];
  const recipients = (recipientResult.data ?? []) as unknown as Recipient[];

  const optedIn = recipients.filter((r) => r.opted_in_at && !r.opt_out_at).length;
  const optedOut = recipients.filter((r) => r.opt_out_at).length;
  const neverOptedIn = recipients.filter((r) => !r.opted_in_at && !r.opt_out_at).length;

  // Spend by model, including discarded calls — a rejected draft cost real
  // money and the report has to say so (rule 10).
  const spendByModel = new Map<string, { cents: number; calls: number; discarded: number }>();
  for (const call of spendResult.data ?? []) {
    const model = call.model as string;
    const current = spendByModel.get(model) ?? { cents: 0, calls: 0, discarded: 0 };
    current.cents += Number(call.cost_cents);
    current.calls++;
    if (call.outcome !== "used") current.discarded++;
    spendByModel.set(model, current);
  }

  const totalCents = [...spendByModel.values()].reduce((sum, m) => sum + m.cents, 0);
  const wastedCents = [...spendByModel.values()].reduce(
    (sum, m) => sum + (m.discarded / Math.max(m.calls, 1)) * m.cents,
    0,
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>
            Signed in as {profile.email} · {profile.role}
          </p>
        </div>
        <SignOutButton />
      </div>

      <div className="stack">
        {/* ── Channels ── */}
        <div className="card">
          <div className="card-head">
            <h2 style={{ fontSize: 15 }}>Channels</h2>
            {!isAdmin(profile) && (
              <span className="tiny dim">Only an admin can connect an account</span>
            )}
          </div>
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>How it publishes</th>
                <th>Status</th>
                <th>Account</th>
              </tr>
            </thead>
            <tbody>
              {connectors.map((connector) => (
                <tr key={connector.id}>
                  <td className="strong">{CHANNEL_LABELS[connector.channel]}</td>
                  <td className="small muted">
                    {connector.kind === "handoff" ? (
                      <>
                        Handed to a person
                        <div className="tiny dim">
                          Generated, checked and scheduled here; a person posts it and confirms
                          with a URL.
                        </div>
                      </>
                    ) : (
                      <>
                        Sent by the system
                        <div className="tiny dim">Delivered to opted-in recipients.</div>
                      </>
                    )}
                  </td>
                  <td>
                    <ConnectorStatusPill status={connector.status} />
                    {connector.last_error && (
                      <div className="tiny muted mt-1">{connector.last_error}</div>
                    )}
                  </td>
                  <td className="small muted">
                    {connector.account_label ?? <span className="dim">—</span>}
                    {connector.last_verified_at && (
                      <div className="tiny dim">
                        checked {formatWhen(connector.last_verified_at)}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Recipients ── */}
        <div className="card">
          <div className="card-head">
            <h2 style={{ fontSize: 15 }}>Newsletter recipients</h2>
            <span className="tiny dim">
              {/* Contact details never reach a public page or the logs
                  (§19.5b), so this is counts only. */}
              Counts only — addresses are never displayed
            </span>
          </div>
          <div className="card-pad">
            <div className="row" style={{ gap: 24 }}>
              <Stat value={optedIn} label="Opted in" />
              <Stat value={neverOptedIn} label="Never opted in" muted />
              <Stat value={optedOut} label="Opted out" muted />
            </div>
            <p className="tiny muted mt-2 mb-0">
              A recipient without consent is never sent to. The check happens in the send path,
              not just at import, so someone who opts out between approval and send is still
              skipped — and counted as skipped rather than quietly dropped.
            </p>
          </div>
        </div>

        {/* ── Brand voice ── */}
        {voices.map((voice) => (
          <div key={voice.id} className="card">
            <div className="card-head">
              <h2 style={{ fontSize: 15 }}>
                Brand voice: {voice.name}
                {voice.is_default && <span className="pill pill-accent tiny"> default</span>}
              </h2>
            </div>
            <div className="card-pad">
              {voice.description && <p className="small muted">{voice.description}</p>}

              <div className="field-row">
                <div>
                  <div className="tiny strong mb-1">Tone rules</div>
                  <ul className="tiny muted" style={{ margin: 0, paddingLeft: 16 }}>
                    {voice.tone_rules.map((rule, i) => (
                      <li key={i}>{rule}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="tiny strong mb-1">
                    Banned phrases
                    <span className="dim"> — checked mechanically, not just judged</span>
                  </div>
                  <div className="tiny muted">
                    {voice.banned_phrases.map((phrase) => (
                      <span key={phrase} className="pill pill-info tiny" style={{ margin: "0 3px 3px 0" }}>
                        {phrase}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}

        {/* ── Spend ── */}
        <div className="card">
          <div className="card-head">
            <h2 style={{ fontSize: 15 }}>Spend, last 30 days</h2>
            <span className="tiny dim">Prices verified {PRICES_VERIFIED_ON}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Calls</th>
                <th>Discarded</th>
                <th style={{ textAlign: "right" }}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {[...spendByModel.entries()]
                .sort((a, b) => b[1].cents - a[1].cents)
                .map(([model, stats]) => (
                  <tr key={model}>
                    <td className="mono tiny">{model}</td>
                    <td>{stats.calls}</td>
                    <td className={stats.discarded > 0 ? "muted" : "dim"}>
                      {stats.discarded > 0 ? stats.discarded : "—"}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Cost cents={stats.cents} />
                    </td>
                  </tr>
                ))}
              {spendByModel.size === 0 && (
                <tr>
                  <td colSpan={4} className="muted small">
                    Nothing spent yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="card-pad" style={{ borderTop: "1px solid var(--border)" }}>
            <div className="row-between small">
              <span>Total</span>
              <Cost cents={totalCents} />
            </div>
            {wastedCents > 0.5 && (
              <div className="row-between tiny muted mt-1">
                <span>Of which discarded output</span>
                <Cost cents={wastedCents} />
              </div>
            )}
            <p className="tiny dim mt-2 mb-0">
              Every call is recorded, including ones whose output was thrown away — a rejected
              draft cost real money, and a report that only counts successes understates what the
              pipeline costs.
            </p>
          </div>
        </div>

        {/* ── Model assignment ── */}
        <div className="card">
          <div className="card-head">
            <h2 style={{ fontSize: 15 }}>Which model does what</h2>
          </div>
          <table>
            <tbody>
              <ModelRow step="Discovery and search" model={MODELS.discovery} why="Query formulation is light judgment; the search tool does the work." />
              <ModelRow step="Angle planning" model={MODELS.planning} why="Short, schema-constrained, three options from a digest." />
              <ModelRow step="Article drafting" model={MODELS.drafting} why="Publication-quality long-form prose. The largest token spend." />
              <ModelRow step="Revision" model={MODELS.revision} why="The same class of work, on a smaller span." />
              <ModelRow step="Evaluation" model={MODELS.evaluation} why="The judge reads one article and writes a paragraph, so judging costs about a third of what writing costs — and an extra cent buys more at the quality gate than at the keyboard." />
              <ModelRow step="Channel adaptation" model={MODELS.adaptation} why="Explicit rules, short outputs, low judgment." />
              <tr>
                <td className="strong small">Chunking, ranking, format checks</td>
                <td className="mono tiny dim">none</td>
                <td className="tiny muted">
                  A splitter and a cosine distance do these. A model call to do a splitter&rsquo;s
                  job is money spent on nothing.
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* ── Environment ── */}
        <div className="card">
          <div className="card-head">
            <h2 style={{ fontSize: 15 }}>Environment</h2>
            <a href="/api/health" className="tiny" target="_blank">
              Health check ↗
            </a>
          </div>
          <div className="card-pad">
            <div className="row-between small">
              <span>Demo mode</span>
              <span className={env.app.demoMode ? "pill pill-warn" : "pill pill-ok"}>
                {env.app.demoMode ? "on — nothing reaches real recipients" : "off — sends are real"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ value, label, muted }: { value: number; label: string; muted?: boolean }) {
  return (
    <div>
      <div
        style={{ fontSize: 22, fontWeight: 650 }}
        className={muted ? "muted" : undefined}
      >
        {value}
      </div>
      <div className="tiny dim">{label}</div>
    </div>
  );
}

function ModelRow({ step, model, why }: { step: string; model: string; why: string }) {
  return (
    <tr>
      <td className="strong small nowrap">{step}</td>
      <td className="mono tiny">{model}</td>
      <td className="tiny muted">{why}</td>
    </tr>
  );
}
