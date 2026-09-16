"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createRequest } from "@/app/actions/requests";
import { ALL_CHANNELS, MAX_SEED_URLS, MIN_IDEA_CHARS } from "@/lib/constants";
import { CHANNEL_LABELS } from "@/components/status";
import type { ChannelName } from "@/lib/db/types";

/**
 * The intake form. DESIGN.md §6.
 *
 * Validation happens here AND in the server action. This copy exists to give
 * immediate feedback; the server's copy is the one that decides, because the
 * UI is not a security boundary.
 */

interface VoiceOption {
  id: string;
  name: string;
  audienceDefault: string | null;
  isDefault: boolean;
}

export function NewRequestForm({
  voices,
  defaultBudgetCents,
  submitToken,
  isDemo,
  budgetCapCents,
}: {
  voices: VoiceOption[];
  defaultBudgetCents: number;
  submitToken: string;
  isDemo: boolean;
  /** Hard ceiling for this workspace, or null when there is none. */
  budgetCapCents: number | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const defaultVoice = voices.find((v) => v.isDefault) ?? voices[0];

  const [idea, setIdea] = useState("");
  const [audience, setAudience] = useState(defaultVoice?.audienceDefault ?? "");
  const [keyword, setKeyword] = useState("");
  const [urlText, setUrlText] = useState("");
  const [channels, setChannels] = useState<ChannelName[]>([...ALL_CHANNELS]);
  const [voiceId, setVoiceId] = useState(defaultVoice?.id ?? "");
  // Held as dollars, submitted as cents.
  const [budget, setBudget] = useState((defaultBudgetCents / 100).toFixed(2));
  const [schedule, setSchedule] = useState<"now" | "later" | "hold">("hold");
  const [publishAt, setPublishAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const seedUrls = urlText
    .split(/[\n,]/)
    .map((u) => u.trim())
    .filter(Boolean);

  // The estimate shown BEFORE research starts (§6). Mirrors
  // estimateRequestCost on the server.
  const estimateCents = estimate(seedUrls.length, channels.length);
  const budgetCents = Math.round((Number.parseFloat(budget) || 0) * 100);
  const overBudget = estimateCents > budgetCents;
  // Refused server-side too; this only saves the round trip.
  const overCap = budgetCapCents != null && budgetCents > budgetCapCents;

  const ideaTooShort = idea.trim().length > 0 && idea.trim().length < MIN_IDEA_CHARS;
  const tooManyUrls = seedUrls.length > MAX_SEED_URLS;
  const canSubmit =
    idea.trim().length >= MIN_IDEA_CHARS &&
    audience.trim().length > 0 &&
    channels.length > 0 &&
    !tooManyUrls &&
    !overBudget &&
    !overCap &&
    !pending;

  function submit() {
    setError(null);

    startTransition(async () => {
      const result = await createRequest({
        idea,
        targetAudience: audience,
        primaryKeyword: keyword || undefined,
        seedUrls,
        channels,
        brandVoiceId: voiceId || undefined,
        budgetCents,
        publishTarget: schedule === "later" && publishAt ? new Date(publishAt).toISOString() : null,
        holdInQueue: schedule === "hold",
        submitToken,
      });

      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      router.push(`/requests/${result.data!.id}`);
    });
  }

  function toggleChannel(channel: ChannelName) {
    setChannels((current) =>
      current.includes(channel) ? current.filter((c) => c !== channel) : [...current, channel],
    );
  }

  return (
    <div className="split">
      <div className="card card-pad">
        {error && <div className="alert alert-error">{error}</div>}

        <div className="field">
          <label htmlFor="idea">The idea</label>
          <textarea
            id="idea"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            rows={4}
            placeholder="What should this article be about? A sentence or two is enough."
          />
          <div className="hint">
            {ideaTooShort
              ? `${MIN_IDEA_CHARS - idea.trim().length} more characters needed, there has to be something to research.`
              : "Plain language. The system turns this into search queries and three angles."}
          </div>
        </div>

        <div className="field">
          <label htmlFor="audience">Target audience</label>
          <input
            id="audience"
            type="text"
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            placeholder="Founders and hiring leads at growing African companies"
          />
          <div className="hint">
            Judged against at evaluation, so be specific about who this is for.
          </div>
        </div>

        <div className="field">
          <label htmlFor="keyword">Primary keyword <span className="dim">(optional)</span></label>
          <input
            id="keyword"
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="remote hiring"
          />
          <div className="hint">
            Leave blank and each angle proposes one for you to confirm.
          </div>
        </div>

        <div className="field">
          <label htmlFor="urls">Source URLs <span className="dim">(optional)</span></label>
          <textarea
            id="urls"
            value={urlText}
            onChange={(e) => setUrlText(e.target.value)}
            rows={3}
            placeholder={"https://example.com/article\nhttps://example.com/report"}
          />
          <div className="hint">
            {tooManyUrls ? (
              <span style={{ color: "var(--danger)" }}>
                {seedUrls.length} URLs, the limit is {MAX_SEED_URLS}, because cost scales with this.
              </span>
            ) : seedUrls.length > 0 ? (
              // §7.2: no search call when the manager supplied URLs. This is
              // the answer to "when should this automation not run".
              `${seedUrls.length} URL${seedUrls.length === 1 ? "" : "s"}. No web search will run unless the idea asks for more, which saves the search cost.`
            ) : (
              "None means the raw-idea path: the system searches for material itself."
            )}
          </div>
        </div>

        <div className="field">
          <label>Channels</label>
          <div className="stack" style={{ gap: 8 }}>
            {ALL_CHANNELS.map((channel) => (
              <label key={channel} className="check">
                <input
                  type="checkbox"
                  checked={channels.includes(channel)}
                  onChange={() => toggleChannel(channel)}
                />
                <span>
                  {CHANNEL_LABELS[channel]}
                  {(channel === "linkedin" || channel === "x") && (
                    <span className="dim tiny">
                      {" "}
                      — generated and scheduled, then handed to a person to post
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="voice">Brand voice</label>
            <select id="voice" value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
              {voices.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            {/* Dollars. The field took CENTS while the estimate beside it was
                shown in dollars, so "60" next to "$0.41" read as sixty dollars
                and bought sixty cents, which is how a request runs out of
                money at the evaluation step. */}
            <label htmlFor="budget">Budget ($)</label>
            <input
              id="budget"
              type="number"
              value={budget}
              min={0.1}
              step={0.05}
              onChange={(e) => setBudget(e.target.value)}
            />
            <div className="hint">
              {/* The cap is named. It used to be applied silently, so a
                  request created at $1.20 ran on $0.60 and then stopped
                  saying the budget was reached. */}
              {budgetCapCents != null
                ? `The demo workspace caps this at $${(budgetCapCents / 100).toFixed(2)}.`
                : "Crossing it stops the request, intact."}
            </div>
          </div>
        </div>

        <div className="field">
          <label>When approved content should go out</label>
          <div className="stack" style={{ gap: 8 }}>
            <label className="check">
              <input
                type="radio"
                name="schedule"
                checked={schedule === "hold"}
                onChange={() => setSchedule("hold")}
              />
              <span>Hold in the queue, decide at approval</span>
            </label>
            <label className="check">
              <input
                type="radio"
                name="schedule"
                checked={schedule === "now"}
                onChange={() => setSchedule("now")}
              />
              <span>As soon as it is approved</span>
            </label>
            <label className="check">
              <input
                type="radio"
                name="schedule"
                checked={schedule === "later"}
                onChange={() => setSchedule("later")}
              />
              <span>At a specific time</span>
            </label>
            {schedule === "later" && (
              <input
                type="datetime-local"
                value={publishAt}
                onChange={(e) => setPublishAt(e.target.value)}
              />
            )}
          </div>
        </div>

        <button className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
          {pending ? (
            <>
              <span className="spin" /> Starting research…
            </>
          ) : (
            "Start research"
          )}
        </button>
      </div>

      <aside className="stack">
        <div className="card card-pad">
          <h3 className="mb-1" style={{ fontSize: 14 }}>
            Estimated cost
          </h3>
          <div style={{ fontSize: 26, fontWeight: 650, letterSpacing: "-0.02em" }}>
            ${(estimateCents / 100).toFixed(2)}
          </div>
          <p className="small muted mt-1 mb-0">
            Research, planning, one draft, evaluation, a revision round and{" "}
            {channels.length} channel version{channels.length === 1 ? "" : "s"}.
          </p>

          {overCap && (
            <div className="alert alert-error mt-2 mb-0 small">
              The demo workspace caps a request at ${(budgetCapCents! / 100).toFixed(2)}. Lower
              the budget to continue.
            </div>
          )}

          {overBudget && (
            <div className="alert alert-error mt-2 mb-0 small">
              This is more than the ${(budgetCents / 100).toFixed(2)} budget, so the request will
              not start. Raise the budget or use fewer sources.
            </div>
          )}
        </div>

        <div className="card card-pad">
          <h3 className="mb-1" style={{ fontSize: 14 }}>
            What happens next
          </h3>
          <ol className="small muted" style={{ paddingLeft: 18, margin: 0, lineHeight: 1.8 }}>
            <li>Sources are found and read</li>
            <li>
              <strong>You confirm the sources and pick an angle</strong>
            </li>
            <li>The article is written from stored excerpts</li>
            <li>It is graded, and weak sections are rewritten</li>
            <li>Each channel version is produced and format-checked</li>
            <li>
              <strong>You approve each channel</strong>
            </li>
            <li>Approved content is released on schedule</li>
          </ol>
        </div>
      </aside>
    </div>
  );
}

/** Mirrors estimateRequestCost on the server (§18.3). */
function estimate(seedUrlCount: number, channelCount: number): number {
  const search = seedUrlCount === 0 ? 4 : 0;
  const scrapes = Math.max(seedUrlCount, 6) * 0.1;
  return Math.ceil(search + scrapes + 0.1 + 1 + 5 + 3.5 + 3 + channelCount * 0.35);
}
