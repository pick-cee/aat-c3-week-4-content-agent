import { articleSections, headingKey } from "./revision-patch";
import { extractMarkdownLinks } from "@/lib/text";
import { MIN_ARTICLE_LINKS } from "@/lib/constants";

/** Keep verified references that an otherwise useful section rewrite dropped. */
export function preserveRevisionLinks(original: string, revised: string, allowedUrls: string[]): string {
  const allowed = new Set(allowedUrls);
  const existing = extractMarkdownLinks(revised);
  const before = articleSections(original);
  const verified = extractMarkdownLinks(original).filter(link => allowed.has(link.url));
  let missing = Math.max(0, Math.min(MIN_ARTICLE_LINKS, verified.length) - existing.length);
  if (!missing) return revised;
  return articleSections(revised).map(section => {
    if (!missing) return section.body.trim();
    const parent = before.find(old => headingKey(old.heading) === headingKey(section.heading));
    const dropped = extractMarkdownLinks(parent?.body ?? "").filter(link => allowed.has(link.url) && !existing.some(current => current.text === link.text && current.url === link.url)).slice(0, missing);
    missing -= dropped.length;
    if (!dropped.length) return section.body.trim();
    return section.body.trim() + "\n\nFurther reading: " + dropped.map(link => `[${link.text}](${link.url})`).join(" and ") + ".";
  }).join("\n\n").trim();
}
