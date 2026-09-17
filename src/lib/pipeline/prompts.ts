import type { BrandVoice, ChannelName } from "@/lib/db/types";
import {
  ARTICLE_MAX_WORDS,
  ARTICLE_MIN_WORDS,
  CHANNEL_LIMITS,
  KEYWORD_FIRST_N_WORDS,
  MAX_ARTICLE_LINKS,
  MIN_ARTICLE_LINKS,
} from "@/lib/constants";

/**
 * Prompt blocks shared across calls.
 *
 * The brand voice, the SEO rules and the rubric are identical across every
 * call in a request, so they are separate system blocks marked cacheable
 * (§18.4). Keeping them here rather than inline at each call site is what
 * makes the cache actually hit — a block that differs by a space is a block
 * that is not cached.
 *
 * The rules themselves come from `assets/seo-best-practices.md` and
 * `assets/channel-formatting-rules.md`.
 */

/**
 * Punctuation rules that apply to every generated word, brand voice or not.
 *
 * Em dashes are the single clearest tell that a machine wrote the text. This
 * lives OUTSIDE brandVoiceBlock deliberately: every call site applies that one
 * as `voice ? [block] : []`, so a request with no brand voice would silently
 * lose the rule. It is also checked in code afterwards, because asking a model
 * not to use them does not reliably work (rule 2: measure the instruction).
 */
export const PUNCTUATION_BLOCK = `── Punctuation, and this is absolute ──

- NEVER use an em dash or an en dash between words. Not once. Those are the
  characters U+2014 and U+2013.
- Use a comma, a full stop, a colon or brackets instead. Recast the sentence
  if you have to.
- An en dash between NUMBERS is fine, as in a year range or a percentage band.
- This is checked mechanically. A single one fails the draft and it is
  written again.`;

export function brandVoiceBlock(voice: BrandVoice): string {
  const parts = [`── Brand voice: ${voice.name} ──`];

  if (voice.description) parts.push(voice.description);

  if (voice.tone_rules.length > 0) {
    parts.push("\nTone rules, all of which apply:");
    parts.push(voice.tone_rules.map((r) => `- ${r}`).join("\n"));
  }

  if (voice.banned_phrases.length > 0) {
    // Checked in code as well as judged (§11.1), so this is not a suggestion.
    parts.push(
      "\nNEVER use these phrases. Their presence is checked mechanically and fails the draft:",
    );
    parts.push(voice.banned_phrases.map((p) => `- "${p}"`).join("\n"));
  }

  if (voice.reading_level) parts.push(`\nReading level: ${voice.reading_level}`);
  if (voice.cta_default) parts.push(`Default call to action: ${voice.cta_default}`);
  parts.push(`Emoji allowance: at most ${voice.emoji_allowance} per post.`);

  return parts.join("\n");
}

/**
 * The SEO rules as explicit constraints (§10). Every one of these is also
 * checked in code — the prompt states them so the model can comply, and
 * `runSeoChecks` measures whether it did.
 */
export const SEO_RULES_BLOCK = `── SEO requirements ──

These are checked mechanically after you write. Failing one sends the draft
back for revision, so treat them as hard constraints rather than advice.

Keywords
- The primary keyword MUST appear in the article title.
- The primary keyword MUST appear within the first ${KEYWORD_FIRST_N_WORDS} words of the body.
- Use the secondary keywords naturally in the body and in section headers.

Structure
- Exactly ONE H1, which is the title.
- H2 for each main section. H3 beneath an H2 only where it genuinely helps.
- Paragraphs of 2 to 3 sentences. Not one long block.
- Let each section's depth reflect how strong the source material for it is.
  A section with one thin excerpt behind it should be short and say so;
  padding it is worse than leaving it brief.

Length
- Between ${ARTICLE_MIN_WORDS} and ${ARTICLE_MAX_WORDS} words.

Links
- ${MIN_ARTICLE_LINKS} to ${MAX_ARTICLE_LINKS} relevant links.
- You do NOT write URLs. See the linking instruction below.`;

/**
 * The citation contract (§8.3). This is the instruction whose outcome is
 * measured rather than trusted.
 */
export const CITATION_BLOCK = `── Citations ──

Every sentence that asserts a fact, a figure, a date, a name, a quotation or
any claim about the world MUST end with one or more excerpt markers, like this:

    Remote hiring in Lagos grew sharply through 2024. [E12]
    Two separate studies found the same pattern. [E3, E17]

Rules:
- Use ONLY the excerpt labels supplied below. A marker naming an excerpt that
  was not supplied causes the entire draft to be discarded and rewritten.
- Narrative connective tissue, the introduction's framing and the call to
  action carry NO marker, and because they carry no marker, they must assert
  nothing. If a sentence needs a citation and has none, rewrite it so it does
  not make the claim.

  Concretely, an UNMARKED sentence may not contain any of these, and a scan
  catches each one:
    · a percentage, an amount of money, or a year
    · any figure beyond a plain count of things in your own argument
    · text inside quotation marks
    · a company, product, person or place name that appears in no excerpt

  This bites hardest in the introduction and the conclusion, where it is
  tempting to open with a statistic and close with a rousing figure. Either
  cite it properly or write the sentence without it.
- Do not cite an excerpt for a claim it does not actually support. Every cited
  sentence is compared against its excerpt automatically, and a real citation
  attached to an unrelated claim is caught and sent back.
- Put the marker after the full stop.

FIGURES, AND THIS IS THE CHECK THAT FAILS DRAFTS MOST OFTEN:

Every number you write must appear VERBATIM in the excerpt you cite for it.
The comparison is a literal string match, so the figure has to survive
unchanged:

- Copy it exactly. "26%" stays "26%". Do not write "about a quarter", "roughly
  26 percent", "one in four" or "over 25%". Those all fail, even though a
  person would call them correct.
- Do not convert, round, combine or infer. If the excerpt says 4,312 you may
  not write "more than 4,000". If two excerpts give parts, you may not add
  them up.
- Do not carry a figure from one excerpt and cite another. The number and the
  marker travel together.
- If you want to characterise a figure rather than state it, drop the number
  entirely and write the claim without one. A sentence with no figure is
  safer than a sentence with an approximated one.

Before you finish, re-read every sentence containing a digit and confirm the
digits appear in the excerpt that sentence cites.`;

/**
 * Links are marked by intent and substituted server-side (rule 3, §10).
 * "A link cannot be wrong because the model never writes one."
 */
export const LINKING_BLOCK = `── Links ──

You do NOT write URLs. Ever. Instead, mark where a link belongs:

    ((link: the original study | E12))

The text before the pipe is the anchor text, which must appear verbatim in
your body. After the pipe is the excerpt label whose source the link should
point at. The server substitutes that source's real URL.

Any URL you write yourself will be treated as a failure.`;

export function channelRulesBlock(channel: ChannelName, emojiAllowance: number): string {
  switch (channel) {
    case "linkedin":
      return `── LinkedIn rules ──

- Use the PAS structure: Problem, then Agitation, then Solution, in that order.
  You will declare the three spans separately, and they are checked for order
  and non-overlap.
- Aim for 180–240 words and roughly 1,600–2,200 characters, leaving room below the hard limit.
- Short paragraphs, at most ${CHANNEL_LIMITS.linkedin.maxLinesPerParagraph} lines each.
- Bullets or simple symbols where they genuinely improve clarity.
- At most ${emojiAllowance} emoji, and only where they fit the brand voice.
- End with a clear call to action as the final block.
- At most ${CHANNEL_LIMITS.linkedin.maxChars} characters.`;

    case "x":
      /**
       * Length is stated as a WORD budget, not just a character limit.
       *
       * Models count characters badly — asked for "at most 280 characters"
       * this produced 470, then 320, then 439 across separate attempts. Words
       * are countable while writing, and roughly 35 words lands near 200
       * characters with comfortable headroom.
       */
      return `── X rules ──

LENGTH IS THE HARD PART. Work to a word budget, not a feeling:

- Write AT MOST 35 WORDS in total, including the hashtags.
- That is about 200 characters, which leaves room under the ${CHANNEL_LIMITS.x.maxChars}
  limit. Posts over the limit are rejected and rewritten.
- Count your words before you answer. Three short lines is the shape.
- A URL counts as ${CHANNEL_LIMITS.x.urlWeight} characters however long it is, and most
  emoji count 2.

Then, within that budget:
- Lead with the benefit, insight or hook. The first line does the work.
- ONE core idea. State it in the coreIdea field in under 15 words.
- Use line breaks for readability.
- ${CHANNEL_LIMITS.x.minHashtags} to ${CHANNEL_LIMITS.x.maxHashtags} relevant hashtags.
- Tag another account only if the tag genuinely adds something.

Do not carry over the article's citation markers, this post is too short to
spend characters on them.`;

    case "newsletter":
      return `── Email newsletter rules ──

- A subject line with a clear benefit or a point of intrigue, at most
  ${CHANNEL_LIMITS.newsletter.maxSubjectChars} characters.
- Open with ${CHANNEL_LIMITS.newsletter.minIntroSentences} to ${CHANNEL_LIMITS.newsletter.maxIntroSentences} sentences.
- Aim for exactly TWO introductory sentences, then insert a blank line before the main section.
- Make the main value section skimmable: at least
  ${CHANNEL_LIMITS.newsletter.minSubheadings} subheadings, or a bulleted block.
- Optionally add a secondary item, a quick tip, a link, an update.
- A clear call to action.
- A friendly sign-off.
- End with a separate two-line sign-off, such as "Best," followed by "Koya Talent" on the next line.
- Aim for 350–450 words in total, including the introduction, CTA and sign-off. Leave room below the upper limit.
- Between ${CHANNEL_LIMITS.newsletter.minWords} and ${CHANNEL_LIMITS.newsletter.maxWords} words. This is
  counted mechanically and is a hard failure outside the band.
- Write as though speaking to a smart, busy reader who trusts you to send
  something useful.`;

  }
}

/** The rubric, for the judged criteria only (§11.1). */
export const RUBRIC_BLOCK = `── Evaluation rubric ──

You are judging FOUR criteria. The others (Source Grounding, Factual
Consistency, SEO Fit, Channel Fit, Completeness) are computed mechanically and
are not yours to assess, their results are given to you as facts.

Topic Relevance, Does the content answer the request and stay focused on the
intended topic?

Audience Fit, Does it speak to the stated target audience at the right level
of depth? Too basic and too advanced are both failures.

Tone, Does the style match the stored brand voice, including its tone rules?
Judge against the voice as written, not against your own preference.

Clarity, Is it easy to read, skimmable and direct?

Score each 1 to 5:
  5, Nothing to fix.
  4, Good; minor polish would help.
  3, Acceptable but noticeably weak in a way a reader would feel.
  2, A real problem. Needs revision.
  1, Fundamentally wrong for this brief. Reject.

If you genuinely cannot assess a criterion, the material to judge it is
missing, return null for the score WITH a reason. Never guess a number, and
never return 0. A null is a legitimate answer; an invented score is not.`;
