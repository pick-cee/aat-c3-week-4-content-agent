import type { ClaimMapEntry, Source } from "@/lib/db/types";
import { segmentSentences, stripMarkdown } from "@/lib/text";

/**
 * The article, with every marked sentence carrying a superscript that opens
 * the exact excerpt text, the source title and the live URL. DESIGN.md §8.6.
 *
 * "Amber for weak, red for flagged. The reviewer is reading the article and
 * can see, without leaving it, what each claim rests on."
 */

export interface ExcerptLookup {
  [excerptId: string]: {
    text: string;
    sourceTitle: string | null;
    sourceUrl: string;
    siteName: string | null;
  };
}

/**
 * Removes what only the pipeline needs to see.
 *
 * A link marker keeps its ANCHOR TEXT: `((link: interview notes | E8))` is a
 * phrase the writer meant to appear, so dropping the whole marker would delete
 * words from the sentence and leave it ungrammatical.
 */
function stripInternalMarkup(markdown: string): string {
  return (
    markdown
      // ((link: anchor | E8)) and the malformed ((link: anchor E8)) both keep
      // the anchor and lose the instruction.
      .replace(/\(\(link:\s*([^|)]+?)\s*(?:\|\s*E\d+\s*)?\)\)/g, "$1")
      // [E13] and [E3, E17].
      .replace(/\s*\[E\d+(?:\s*,\s*E\d+)*\]/g, "")
      // A marker sitting before punctuation leaves " ." behind.
      .replace(/\s+([.,;:!?])/g, "$1")
  );
}

/** Exposed for the unit test: this guards the one public page in the system. */
export const stripInternalMarkupForTest = stripInternalMarkup;

export function ArticleView({
  bodyMd,
  claimMap,
  excerpts,
  sources,
  showCitations = true,
}: {
  bodyMd: string;
  claimMap: ClaimMapEntry[] | null;
  excerpts?: ExcerptLookup;
  sources?: Source[];
  showCitations?: boolean;
}) {
  const byIndex = new Map((claimMap ?? []).map((entry) => [entry.sentenceIndex, entry]));

  /**
   * A reader never sees the machinery.
   *
   * `showCitations={false}` only suppressed the superscript BADGE; the
   * sentence text still carried its raw `[E13]` markers and any
   * `((link: anchor | E14))` the server had not substituted. Both were
   * printing on the public permalink, which is the one page in this system a
   * stranger reads.
   *
   * Stripped at render, not in storage: the markers are the grounding record
   * and every check depends on them surviving on the row.
   */
  const readable = showCitations ? bodyMd : stripInternalMarkup(bodyMd);

  return (
    <div className="article">
      {renderBlocks(readable, byIndex, excerpts ?? {}, sources ?? [], showCitations)}
    </div>
  );
}

/**
 * Renders markdown to React, annotating sentences from the claim map.
 *
 * A markdown library would be the obvious choice, but the annotation has to
 * happen at sentence granularity inside paragraphs, which means walking the
 * text anyway. The subset the drafter produces is known and small.
 */
function renderBlocks(
  markdown: string,
  byIndex: Map<number, ClaimMapEntry>,
  excerpts: ExcerptLookup,
  sources: Source[],
  showCitations: boolean,
): React.ReactNode[] {
  const blocks = markdown.split(/\n\s*\n/);
  const out: React.ReactNode[] = [];

  // The claim map indexes sentences across the WHOLE body, so the counter runs
  // continuously rather than resetting per block.
  let sentenceIndex = 0;

  blocks.forEach((raw, blockIndex) => {
    const block = raw.trim();
    if (!block) return;

    const heading = /^(#{1,6})\s+(.+)$/.exec(block);
    if (heading) {
      const level = Math.min(heading[1]!.length, 3);
      const Tag = (`h${level}` as unknown) as keyof React.JSX.IntrinsicElements;
      // Headings are counted too: stripMarkdown keeps their text, so the claim
      // map's indices include them.
      const count = segmentSentences(stripMarkdown(heading[2]!)).length;
      const node = <Tag key={blockIndex}>{heading[2]}</Tag>;
      sentenceIndex += count;
      out.push(node);
      return;
    }

    if (/^\s*[-*+]\s+/m.test(block)) {
      const items = block.split("\n").filter((line) => /^\s*[-*+]\s+/.test(line));
      out.push(
        <ul key={blockIndex}>
          {items.map((line, i) => {
            const text = line.replace(/^\s*[-*+]\s+/, "");
            const node = (
              <li key={i}>
                {annotate(text, sentenceIndex, byIndex, excerpts, sources, showCitations)}
              </li>
            );
            sentenceIndex += segmentSentences(stripMarkdown(text)).length;
            return node;
          })}
        </ul>,
      );
      return;
    }

    if (/^\s*>/.test(block)) {
      const text = block.replace(/^\s*>\s?/gm, "");
      out.push(
        <blockquote key={blockIndex}>
          {annotate(text, sentenceIndex, byIndex, excerpts, sources, showCitations)}
        </blockquote>,
      );
      sentenceIndex += segmentSentences(stripMarkdown(text)).length;
      return;
    }

    out.push(
      <p key={blockIndex}>
        {annotate(block, sentenceIndex, byIndex, excerpts, sources, showCitations)}
      </p>,
    );
    sentenceIndex += segmentSentences(stripMarkdown(block)).length;
  });

  return out;
}

/** Splits a block into sentences and attaches each one's citation. */
function annotate(
  text: string,
  startIndex: number,
  byIndex: Map<number, ClaimMapEntry>,
  excerpts: ExcerptLookup,
  sources: Source[],
  showCitations: boolean,
): React.ReactNode[] {
  const sentences = segmentSentences(stripMarkdown(text));

  return sentences.map((sentence, i) => {
    const entry = byIndex.get(startIndex + i);

    if (!entry || !showCitations || entry.labels.length === 0) {
      return <span key={i}>{inlineFormat(sentence.text)} </span>;
    }

    const className =
      entry.verdict === "unsupported"
        ? "sentence-unsupported"
        : entry.verdict === "weak"
          ? "sentence-weak"
          : undefined;

    return (
      <span key={i} className={className}>
        {inlineFormat(sentence.text)}
        <Citation entry={entry} excerpts={excerpts} sources={sources} />{" "}
      </span>
    );
  });
}

function Citation({
  entry,
  excerpts,
  sources,
}: {
  entry: ClaimMapEntry;
  excerpts: ExcerptLookup;
  sources: Source[];
}) {
  const className =
    entry.verdict === "unsupported"
      ? "cite cite-unsupported"
      : entry.verdict === "weak"
        ? "cite cite-weak"
        : "cite";

  // The tooltip carries the excerpt text, the source and the score, so the
  // reviewer never has to leave the article to see what a claim rests on.
  const detail = entry.excerptIds
    .map((id) => {
      const excerpt = excerpts[id];
      if (!excerpt) return null;
      return `${excerpt.sourceTitle ?? excerpt.siteName ?? "Source"}:\n"${excerpt.text.slice(0, 400)}"`;
    })
    .filter(Boolean)
    .join("\n\n");

  const scoreNote =
    entry.groundingScore == null
      ? "This citation could not be scored."
      : `Similarity to the cited excerpt: ${(entry.groundingScore * 100).toFixed(0)}%` +
        (entry.verdict === "weak"
          ? ", weak. The citation is real but only loosely related."
          : entry.verdict === "unsupported"
            ? ", the cited excerpt does not appear to support this claim."
            : "");

  const firstSource = sources.find((s) => entry.sourceIds.includes(s.id));

  return (
    <a
      href={firstSource?.url ?? "#"}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      title={[entry.labels.join(", "), scoreNote, detail].filter(Boolean).join("\n\n")}
    >
      {entry.labels.join(",")}
    </a>
  );
}

/** Bold, italic, code and links. Links are already real URLs (rule 3). */
function inlineFormat(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)|\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`]+)`/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));

    if (match[1] && match[2]) {
      parts.push(
        <a key={key++} href={match[2]} target="_blank" rel="noopener noreferrer">
          {match[1]}
        </a>,
      );
    } else if (match[3]) {
      parts.push(<strong key={key++}>{match[3]}</strong>);
    } else if (match[4]) {
      parts.push(<em key={key++}>{match[4]}</em>);
    } else if (match[5]) {
      parts.push(<code key={key++}>{match[5]}</code>);
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length > 0 ? parts : text;
}
