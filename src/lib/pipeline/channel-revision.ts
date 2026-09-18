import { normaliseNumberText, NUMBER_TOKEN } from "./number-text";
import { stripMarkers } from "./grounding";
import type { ArticleVersion, ChannelOutput } from "@/lib/db/types";

export function channelRevisionPrompt(previous: ChannelOutput, note: string): string {
  return [
    "REVISION OF THE SAVED CHANNEL VERSION",
    "Revise only the section or aspect requested below. Preserve unrelated sections and the subject verbatim unless the request or format rules require a change.",
    "Return the complete revised channel output in the required schema, not an explanation or a patch.",
    "The article above is the sole factual authority. The previous copy and the editor's note are not sources. Do not add facts, figures or claims absent from the article, even if the note requests them.",
    "Restore the article's citation markers on factual statements before returning the output. Fix the listed format problems without rewriting unrelated copy.",
    "Previous channel copy: " + JSON.stringify({ subject: previous.subject, body: previous.body, hashtags: previous.hashtags }),
    "Existing format problems: " + JSON.stringify(previous.format_check?.checks.filter(c => !c.passed).map(c => c.detail) ?? []),
    "Requested change: " + JSON.stringify(note),
  ].join("\n\n");
}

/** Cheap additional guard for channel revisions; this is not a semantic fact checker. */
export function channelRevisionSourceIssues(body: string, article: ArticleVersion, articleUrl: string | null): string[] {
  const urls = (text: string) => text.match(/https?:\/\/[^\s)\]>]+/g) ?? [];
  const allowedUrls = new Set([...urls(article.body_md), ...(articleUrl ? [articleUrl] : [])]);
  const numbers = (text: string) => [...normaliseNumberText(stripMarkers(text).replace(/https?:\/\/[^\s)\]>]+/g, "")).matchAll(NUMBER_TOKEN)]
    .map(m => m[0].replace(/,/g, ""));
  const known = new Set(numbers(article.body_md));
  const unknown = [...new Set(numbers(body))].filter(n => !known.has(n) && !(Number.isInteger(Number(n)) && Number(n) >= 0 && Number(n) <= 10));
  return [
    ...unknown.map(n => `The figure ${n} is absent from the article.`),
    ...urls(body).filter(url => !allowedUrls.has(url)).map(() => "A link is absent from the article and its approved permalink."),
  ];
}
