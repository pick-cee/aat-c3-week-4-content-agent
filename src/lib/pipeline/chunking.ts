/**
 * Deterministic chunking. No model involved.
 *
 * DESIGN.md §5.5: "Chunking is deterministic: split on markdown headings, then
 * pack paragraphs to roughly 250–400 tokens without splitting a sentence,
 * carrying the heading path. No model is involved in chunking. A model call to
 * do something a splitter does is money spent on nothing."
 */

import {
  CHUNK_TARGET_TOKENS_MIN,
  CHUNK_TARGET_TOKENS_MAX,
} from "@/lib/constants";
import { estimateTokens, segmentSentences } from "@/lib/text";

export interface Chunk {
  ordinal: number;
  text: string;
  /** e.g. "Getting started > Installing". Carried into the prompt (§8.1). */
  headingPath: string;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
}

interface Block {
  text: string;
  headingPath: string;
  charStart: number;
  charEnd: number;
}

export function chunkMarkdown(markdown: string): Chunk[] {
  const blocks = splitIntoBlocks(markdown);
  const chunks: Chunk[] = [];
  let ordinal = 0;

  // Pack within a heading section, never across one: an excerpt that spans two
  // unrelated sections cites badly and reads worse.
  for (const group of groupByHeading(blocks)) {
    for (const packed of packBlocks(group)) {
      chunks.push({ ...packed, ordinal: ordinal++ });
    }
  }

  return chunks;
}

/** Paragraph-level blocks, each tagged with the heading path above it. */
function splitIntoBlocks(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  const headingStack: string[] = [];

  let buffer: string[] = [];
  let bufferStart = 0;
  let offset = 0;
  let inFence = false;

  const flush = (end: number) => {
    const text = buffer.join("\n").trim();
    if (text.length > 0) {
      blocks.push({
        text,
        headingPath: headingStack.join(" > "),
        charStart: bufferStart,
        charEnd: end,
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;

    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (buffer.length === 0) bufferStart = lineStart;
      buffer.push(line);
      continue;
    }

    if (!inFence) {
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        flush(lineStart);
        const level = heading[1]!.length;
        // Trim the stack to this level, then push. A jump from H2 to H4 keeps
        // the H2 rather than inventing an H3 that was never there.
        headingStack.length = Math.min(headingStack.length, level - 1);
        headingStack[level - 1] = heading[2]!.trim();
        for (let i = 0; i < level - 1; i++) headingStack[i] ??= "";
        bufferStart = offset;
        continue;
      }

      if (line.trim() === "") {
        flush(lineStart);
        bufferStart = offset;
        continue;
      }
    }

    if (buffer.length === 0) bufferStart = lineStart;
    buffer.push(line);
  }

  flush(offset);
  return blocks.filter((block) => block.text.length > 0);
}

function groupByHeading(blocks: Block[]): Block[][] {
  const groups: Block[][] = [];
  let current: Block[] = [];
  let path: string | null = null;

  for (const block of blocks) {
    if (path !== null && block.headingPath !== path) {
      if (current.length > 0) groups.push(current);
      current = [];
    }
    path = block.headingPath;
    current.push(block);
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

/** Packs blocks toward the target window, splitting only on sentence bounds. */
function packBlocks(blocks: Block[]): Omit<Chunk, "ordinal">[] {
  const out: Omit<Chunk, "ordinal">[] = [];
  let buffer: Block[] = [];
  let tokens = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const first = buffer[0]!;
    const last = buffer[buffer.length - 1]!;
    const text = buffer.map((b) => b.text).join("\n\n");
    out.push({
      text,
      headingPath: first.headingPath,
      charStart: first.charStart,
      charEnd: last.charEnd,
      tokenEstimate: estimateTokens(text),
    });
    buffer = [];
    tokens = 0;
  };

  for (const block of blocks) {
    const blockTokens = estimateTokens(block.text);

    // One block larger than the window: split it on sentence boundaries rather
    // than mid-sentence, because a truncated sentence embeds badly and reads
    // as a broken quotation when shown to a reviewer (§8.6).
    if (blockTokens > CHUNK_TARGET_TOKENS_MAX) {
      flush();
      for (const piece of splitLongBlock(block)) out.push(piece);
      continue;
    }

    if (tokens + blockTokens > CHUNK_TARGET_TOKENS_MAX && tokens >= CHUNK_TARGET_TOKENS_MIN) {
      flush();
    }

    buffer.push(block);
    tokens += blockTokens;
  }

  flush();
  return out;
}

function splitLongBlock(block: Block): Omit<Chunk, "ordinal">[] {
  const sentences = segmentSentences(block.text);
  const out: Omit<Chunk, "ordinal">[] = [];

  let buffer: typeof sentences = [];
  let tokens = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer.map((s) => s.text).join(" ");
    const first = buffer[0]!;
    const last = buffer[buffer.length - 1]!;
    out.push({
      text,
      headingPath: block.headingPath,
      charStart: block.charStart + first.start,
      charEnd: block.charStart + last.end,
      tokenEstimate: estimateTokens(text),
    });
    buffer = [];
    tokens = 0;
  };

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence.text);
    if (tokens + sentenceTokens > CHUNK_TARGET_TOKENS_MAX && buffer.length > 0) flush();
    buffer.push(sentence);
    tokens += sentenceTokens;
  }

  flush();

  // A single sentence longer than the window (a table row, a minified line)
  // still has to become one chunk rather than vanish.
  if (out.length === 0) {
    out.push({
      text: block.text,
      headingPath: block.headingPath,
      charStart: block.charStart,
      charEnd: block.charEnd,
      tokenEstimate: estimateTokens(block.text),
    });
  }

  return out;
}
