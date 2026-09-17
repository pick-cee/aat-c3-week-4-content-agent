"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createRequest } from "@/app/actions/requests";
import { ALL_CHANNELS, MAX_SEED_URLS, MIN_IDEA_CHARS, MAX_IDEA_CHARS } from "@/lib/constants";
import { estimateRequestCost, requestInputSchema } from "@/lib/intake";
import { CHANNEL_LABELS } from "@/components/status";
import { Icon } from "@/components/icon";
import type { ChannelName } from "@/lib/db/types";

interface VoiceOption { id: string; name: string; audienceDefault: string | null; isDefault: boolean }

export function NewRequestForm({ voices, defaultBudgetCents, submitToken, budgetCapCents }: {
  voices: VoiceOption[]; defaultBudgetCents: number; submitToken: string; isDemo: boolean; budgetCapCents: number | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const defaultVoice = voices.find(v => v.isDefault) ?? voices[0];
  const [idea, setIdea] = useState("");
  const [audience, setAudience] = useState(defaultVoice?.audienceDefault ?? "");
  const [keyword, setKeyword] = useState("");
  const [urlText, setUrlText] = useState("");
  const [channels, setChannels] = useState<ChannelName[]>([...ALL_CHANNELS]);
  const [voiceId, setVoiceId] = useState(defaultVoice?.id ?? "");
  const [budget, setBudget] = useState((defaultBudgetCents / 100).toFixed(2));
  const [schedule, setSchedule] = useState<"now" | "later" | "hold">("hold");
  const [publishAt, setPublishAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const seedUrls = [...new Set(urlText.split(/\n/).map(u => u.trim()).filter(Boolean))];
  const estimateCents = estimateRequestCost(seedUrls.length, channels.length);
  const budgetCents = Math.round((Number.parseFloat(budget) || 0) * 100);
  const overBudget = estimateCents > budgetCents;
  const overCap = budgetCapCents != null && budgetCents > budgetCapCents;
  const scheduledDate = publishAt ? new Date(publishAt) : null;
  const scheduleValid = schedule !== "later" || (scheduledDate && Number.isFinite(scheduledDate.getTime()) && scheduledDate.getTime() > Date.now());
  const canSubmit = idea.trim().length >= MIN_IDEA_CHARS && audience.trim().length >= 3 && channels.length > 0 && seedUrls.length <= MAX_SEED_URLS && !overBudget && !overCap && scheduleValid && !pending;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!canSubmit) { setError("Add your brief, audience, and at least one channel. Check the budget and schedule before continuing."); return; }
    const input = { idea, targetAudience: audience, primaryKeyword: keyword || undefined, seedUrls, channels, brandVoiceId: voiceId || undefined, budgetCents, publishTarget: schedule === "later" ? scheduledDate!.toISOString() : null, holdInQueue: schedule === "hold", submitToken };
    const parsed = requestInputSchema.safeParse(input);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Please check your brief."); return; }
    startTransition(async () => {
      try {
        const result = await createRequest(parsed.data);
        if (!result.ok || !result.data) { setError(result.error ?? "The request could not be created. Please try again."); return; }
        router.push(`/requests/${result.data.id}`);
      } catch { setError("We couldn’t confirm your request. Try again; submitting the same brief here won’t create a duplicate."); }
    });
  }

  return <form className="create-layout" onSubmit={submit}>
    <div className="brief-sections">
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <section className="brief-section"><div className="form-section-title"><span>01</span><div><h2>Start with the idea</h2><p>What should your audience take away from this piece?</p></div></div>
        <div className="field"><label htmlFor="idea">Content brief <span className="required">*</span></label><textarea id="idea" required minLength={MIN_IDEA_CHARS} maxLength={MAX_IDEA_CHARS} value={idea} onChange={e => setIdea(e.target.value)} rows={5} placeholder="e.g. A practical guide to building a remote hiring process for growing teams. Focus on evaluating candidates fairly, with useful examples." /><div className="field-foot"><span>Give us a topic, perspective, and anything worth covering.</span><span>{idea.length}/{MAX_IDEA_CHARS}</span></div></div>
        <div className="field"><label htmlFor="audience">Who is it for? <span className="required">*</span></label><input id="audience" required minLength={3} maxLength={500} value={audience} onChange={e => setAudience(e.target.value)} placeholder="e.g. Founders and people leads at growing companies" /></div>
        <div className="field-row"><div className="field"><label htmlFor="voice">Brand voice</label><select id="voice" value={voiceId} onChange={e => { const voice = voices.find(v=>v.id===e.target.value); setVoiceId(e.target.value); if (!audience.trim()) setAudience(voice?.audienceDefault ?? ""); }}>{!voices.length && <option value="">Default editorial voice</option>}{voices.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></div><div className="field"><label htmlFor="keyword">SEO keyword <span className="dim">optional</span></label><input id="keyword" maxLength={100} value={keyword} onChange={e=>setKeyword(e.target.value)} placeholder="We can suggest one" /></div></div>
      </section>
      <section className="brief-section"><div className="form-section-title"><span>02</span><div><h2>Give it a starting point</h2><p>Add trusted sources to focus research and reduce search costs.</p></div></div><div className="field mb-0"><label htmlFor="urls">Source links <span className="dim">optional</span></label><textarea id="urls" value={urlText} onChange={e=>setUrlText(e.target.value)} rows={3} placeholder="Paste one article, report, or website URL per line" /><div className="hint">{seedUrls.length ? `${seedUrls.length} of ${MAX_SEED_URLS} sources. Web search is skipped unless you explicitly ask for more sources.` : "No links? We’ll search for relevant sources and let you review them."}</div></div></section>
      <section className="brief-section"><div className="form-section-title"><span>03</span><div><h2>Choose where it goes</h2><p>Your article is included. Add the channels you need.</p></div></div><fieldset className="channel-choices"><legend className="sr-only">Channels</legend>{ALL_CHANNELS.map(channel=><label className={`channel-choice ${channels.includes(channel) ? "is-selected" : ""}`} key={channel}><input type="checkbox" checked={channels.includes(channel)} onChange={()=>setChannels(current=>current.includes(channel) ? current.filter(c=>c!==channel) : [...current,channel])} /><span className="channel-logo" aria-hidden="true">{channel === "linkedin" ? "in" : channel === "x" ? "𝕏" : "@"}</span><strong>{CHANNEL_LABELS[channel]}</strong><small>{channel === "newsletter" ? "Email edition" : "Ready to copy & post"}</small></label>)}</fieldset>
        <details className="schedule-details"><summary>Scheduling preferences <span className="muted">{schedule === "hold" ? "Decide after review" : schedule === "now" ? "After approval" : "Specific time"}</span></summary><div className="stack mt-2">{[{value:"hold",label:"Decide after reviewing the content"},{value:"now",label:"Release as soon as I approve"},{value:"later",label:"Choose a date and time"}].map(option=><label className="check" key={option.value}><input type="radio" name="schedule" checked={schedule===option.value} onChange={()=>setSchedule(option.value as typeof schedule)} />{option.label}</label>)}{schedule === "later" && <div className="field"><label htmlFor="publish-at">Publish time (your local time)</label><input id="publish-at" type="datetime-local" required value={publishAt} onChange={e=>setPublishAt(e.target.value)} /></div>}</div></details>
      </section>
    </div>
    <aside className="create-sidebar"><div className="brief-summary"><div className="eyebrow">YOUR CONTENT PLAN</div><h2>One idea. More possibilities.</h2><div className="summary-deliverable"><Icon name="file" /><div><strong>Source-backed article</strong><small>With an SEO title and description</small></div></div><div className="summary-deliverable"><Icon name="grid" /><div><strong>{channels.length} channel {channels.length === 1 ? "version" : "versions"}</strong><small>{channels.map(c=>CHANNEL_LABELS[c]).join(" · ") || "Select at least one channel"}</small></div></div><div className="estimate-block"><div><span>Estimated AI cost</span><strong>${(estimateCents / 100).toFixed(2)}</strong></div><p>Includes research, writing, checks, one revision, and your selected channels. Actual usage varies.</p></div><div className="field"><label htmlFor="budget">Spending limit (USD)</label><input id="budget" type="number" required min={0.1} max={budgetCapCents ? budgetCapCents / 100 : 100} step={0.01} value={budget} onChange={e=>setBudget(e.target.value)} /><div className="hint">{budgetCapCents ? `Demo limit: $${(budgetCapCents / 100).toFixed(2)} per request.` : "Work pauses before the next call would exceed this limit."}</div></div>{(overCap || overBudget) && <div className="alert alert-warn small">{overCap ? "This budget exceeds the workspace limit." : "Raise the limit to cover the estimate, or select fewer channels."}</div>}<button type="submit" className="btn btn-primary btn-full" disabled={!canSubmit}>{pending ? <><span className="spin" />Creating your brief…</> : <>Start creating<Icon name="arrow" size={17} /></>}</button><p className="submission-note">You’ll review sources and choose an angle before writing begins.</p></div><div className="creation-promise"><Icon name="check" size={18} /><span>You stay in control.<br /><strong>Every channel needs your approval.</strong></span></div></aside>
  </form>;
}
