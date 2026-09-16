"use client";

import { useState } from "react";
import { updateBrandVoice } from "@/app/actions/settings";
import { useAction } from "../review/use-action";
import type { BrandVoice } from "@/lib/db/types";

/**
 * Editing the voice every generation call is governed by.
 *
 * Tone rules and banned phrases reach drafting, revision and all three channel
 * adapters, and banned phrases are checked mechanically rather than judged —
 * so this is not cosmetic configuration. It was read-only, which meant the only
 * way to change how the system writes was to edit a seed file and re-run it.
 *
 * Rules are one per line: a list of short imperatives is what the prompt wants,
 * and a textarea is the honest control for that. Anything fancier would be a
 * worse version of a text editor.
 */
export function BrandVoiceEditor({ voice }: { voice: BrandVoice }) {
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);

  const [name, setName] = useState(voice.name);
  const [description, setDescription] = useState(voice.description ?? "");
  const [audience, setAudience] = useState(voice.audience_default ?? "");
  const [tone, setTone] = useState(voice.tone_rules.join("\n"));
  const [banned, setBanned] = useState(voice.banned_phrases.join("\n"));
  const [cta, setCta] = useState(voice.cta_default ?? "");
  const [reading, setReading] = useState(voice.reading_level ?? "");
  const [emoji, setEmoji] = useState(String(voice.emoji_allowance));

  function save() {
    setSaved(false);
    action.run(async () => {
      const result = await updateBrandVoice(voice.id, {
        name,
        description,
        audienceDefault: audience,
        toneRules: tone.split("\n"),
        bannedPhrases: banned.split("\n"),
        ctaDefault: cta,
        readingLevel: reading,
        emojiAllowance: Number.parseInt(emoji, 10),
      });
      if (result.ok) {
        setEditing(false);
        setSaved(true);
      }
      return result;
    });
  }

  function cancel() {
    // Reset to what is stored, so cancelling genuinely discards.
    setName(voice.name);
    setDescription(voice.description ?? "");
    setAudience(voice.audience_default ?? "");
    setTone(voice.tone_rules.join("\n"));
    setBanned(voice.banned_phrases.join("\n"));
    setCta(voice.cta_default ?? "");
    setReading(voice.reading_level ?? "");
    setEmoji(String(voice.emoji_allowance));
    action.clearError();
    setEditing(false);
  }

  if (!editing) {
    return (
      <>
        <div className="section-head">
          <div className="min-w-0">
            <h2 className="section-title">Brand voice</h2>
            {/* A flex row, not a leading space inside the pill: the space
                collapsed and the badge sat flush against the name. */}
            <div className="row" style={{ gap: 8, marginTop: 4 }}>
              <span className="small strong">{voice.name}</span>
              {voice.is_default && <span className="pill pill-accent tiny">default</span>}
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {saved && <span className="tiny" style={{ color: "var(--ok)" }}>Saved</span>}
            <button className="btn btn-sm" onClick={() => setEditing(true)}>
              Edit voice
            </button>
          </div>
        </div>
        <hr className="section-rule" />

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
              <span className="dim">, checked mechanically, not just judged</span>
            </div>
            <div className="tiny muted">
              {voice.banned_phrases.length === 0 ? (
                <span className="dim">None.</span>
              ) : (
                voice.banned_phrases.map((phrase) => (
                  <span
                    key={phrase}
                    className="pill pill-info tiny"
                    style={{ margin: "0 3px 3px 0" }}
                  >
                    {phrase}
                  </span>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="tiny dim mt-2">
          At most {voice.emoji_allowance} emoji per post
          {voice.reading_level && ` · ${voice.reading_level}`}
          {voice.audience_default && ` · default audience: ${voice.audience_default}`}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="section-head">
        <h2 className="section-title">Editing brand voice</h2>
      </div>
      <hr className="section-rule" />

      {action.error && <div className="alert alert-error small">{action.error}</div>}

      <div className="field-row">
        <div className="field">
          <label htmlFor="voice-name">Name</label>
          <input id="voice-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="voice-audience">Default audience</label>
          <input
            id="voice-audience"
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            placeholder="Founders at growing African companies"
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="voice-desc">Description</label>
        <textarea
          id="voice-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
        <div className="hint">How the writing should feel. This reaches every call.</div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="voice-tone">Tone rules, one per line</label>
          <textarea
            id="voice-tone"
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            rows={8}
          />
          <div className="hint">
            Short imperatives work best: &ldquo;Lead with the point.&rdquo; Each one is given to
            the model as a rule it must follow.
          </div>
        </div>
        <div className="field">
          <label htmlFor="voice-banned">Banned phrases, one per line</label>
          <textarea
            id="voice-banned"
            value={banned}
            onChange={(e) => setBanned(e.target.value)}
            rows={8}
          />
          <div className="hint">
            These are checked in code, not judged. A draft containing one fails the evaluation
            rather than relying on the model to have noticed.
          </div>
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="voice-cta">Default call to action</label>
          <input id="voice-cta" value={cta} onChange={(e) => setCta(e.target.value)} />
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="voice-reading">Reading level</label>
            <input
              id="voice-reading"
              value={reading}
              onChange={(e) => setReading(e.target.value)}
              placeholder="Plain English"
            />
          </div>
          <div className="field">
            <label htmlFor="voice-emoji">Emoji allowance</label>
            <input
              id="voice-emoji"
              type="number"
              min={0}
              max={10}
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="row">
        <button className="btn btn-primary btn-sm" disabled={action.pending} onClick={save}>
          {action.pending ? <span className="spin" /> : "Save voice"}
        </button>
        <button className="btn btn-sm btn-ghost" disabled={action.pending} onClick={cancel}>
          Cancel
        </button>
        <span className="tiny dim">
          Applies to the next draft. Articles already written are unchanged.
        </span>
      </div>
    </>
  );
}
