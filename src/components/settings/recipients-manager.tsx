"use client";

import { useState } from "react";
import { addRecipients, optOutRecipient, optInRecipient } from "@/app/actions/settings";
import { useAction } from "../review/use-action";
import type { Recipient } from "@/lib/db/types";

/**
 * The newsletter list: who it goes to, and adding people to it.
 *
 * The page showed three counts and no addresses, which answered "how many"
 * without answering "who" — and there was no way to add anyone, so the only
 * recipients that ever existed were the six demo rows seeded on first boot.
 *
 * Addresses are shown to a reviewer who can already send to them, and never on
 * a public page, in the activity log, or in a screenshot of one (rule 9c).
 * Opting out keeps the row: deleting it would let the next import re-add
 * someone who asked to be left alone.
 */
export function RecipientsManager({
  recipients,
  canEdit,
}: {
  recipients: Recipient[];
  canEdit: boolean;
}) {
  const action = useAction();
  const [adding, setAdding] = useState(false);
  const [raw, setRaw] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const active = recipients.filter((r) => r.opted_in_at && !r.opt_out_at);
  const pending = recipients.filter((r) => !r.opted_in_at && !r.opt_out_at);
  const out = recipients.filter((r) => r.opt_out_at);

  function submit() {
    setNote(null);
    action.run(async () => {
      const result = await addRecipients(raw);
      if (result.ok) {
        const added = result.data?.added ?? 0;
        const skipped = result.data?.skipped.length ?? 0;
        setNote(
          `${added} added` + (skipped > 0 ? `, ${skipped} already on the list.` : "."),
        );
        setRaw("");
        setAdding(false);
      }
      return result;
    });
  }

  return (
    <>
      <div className="section-head">
        <div className="min-w-0">
          <h2 className="section-title">Newsletter list</h2>
          <div className="tiny dim" style={{ marginTop: 4 }}>
            {active.length} will receive the next send
            {pending.length > 0 && ` · ${pending.length} never opted in`}
            {out.length > 0 && ` · ${out.length} opted out`}
          </div>
        </div>
        {canEdit && !adding && (
          <button className="btn btn-sm" onClick={() => setAdding(true)}>
            Add people
          </button>
        )}
      </div>
      <hr className="section-rule" />

      {action.error && <div className="alert alert-error small">{action.error}</div>}
      {note && <div className="alert alert-ok small">{note}</div>}

      {adding && (
        <div className="field">
          <label htmlFor="new-recipients">Email addresses, one per line</label>
          <textarea
            id="new-recipients"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={4}
            placeholder={"maya@example.com\nsam@example.com"}
          />
          <div className="hint">
            Only add people who have agreed to hear from you. Each one is recorded as opted in by
            you, with the date, that record is what the send path checks.
          </div>
          <div className="btn-row mt-1">
            <button
              className="btn btn-primary btn-sm"
              disabled={action.pending || !raw.trim()}
              onClick={submit}
            >
              {action.pending ? <span className="spin" /> : "Add to the list"}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setAdding(false);
                setRaw("");
                action.clearError();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {recipients.length === 0 ? (
        <p className="small muted mb-0">
          Nobody is on the newsletter list yet. A newsletter with no recipients is approved and
          queued as normal, and sends to nobody.
        </p>
      ) : (
        <div className="rows">
          {[...active, ...pending, ...out].map((person) => {
            const isOut = Boolean(person.opt_out_at);
            const neverIn = !person.opted_in_at && !isOut;
            return (
              <div key={person.id} className="row-item">
                <div className="row-main">
                  <div className="row-title" style={{ fontWeight: 450 }}>
                    {person.handle}
                  </div>
                  {person.opt_in_source && !isOut && (
                    <div className="row-sub">{person.opt_in_source}</div>
                  )}
                </div>
                <div className="row-side">
                  {isOut ? (
                    <span
                      className="pill pill-info tiny"
                      title="Not sent to. A reviewer can re-subscribe them; their own unsubscribe link cannot."
                    >
                      Opted out
                    </span>
                  ) : neverIn ? (
                    <span
                      className="pill pill-warn tiny"
                      title="No consent on record, so the send path skips them and counts it."
                    >
                      Never opted in
                    </span>
                  ) : (
                    <span className="pill pill-ok tiny">Opted in</span>
                  )}
                  {canEdit &&
                    (isOut ? (
                      /* Unsubscribing by mistake used to be unrecoverable
                         without deleting the row and losing its history. */
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={action.pending}
                        onClick={() => action.run(() => optInRecipient(person.id))}
                        title="Puts them back on the list, with a new consent record naming you and the date."
                      >
                        Re-subscribe
                      </button>
                    ) : (
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={action.pending}
                        onClick={() => action.run(() => optOutRecipient(person.id))}
                        title="Takes effect immediately. The row is kept so a later import cannot quietly re-add them."
                      >
                        Opt out
                      </button>
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="tiny dim mt-2 mb-0">
        A recipient without consent is never sent to. The check happens in the send path, not
        just at import, so someone who opts out between approval and send is still skipped, and
        counted as skipped rather than quietly dropped.
      </p>
    </>
  );
}
