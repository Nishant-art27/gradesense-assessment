import type { PageText } from '@gradesense/shared';
import { estimateTokens } from '../grading/tokens.js';

/**
 * Splitting a document into pieces a model can be sent one at a time.
 *
 * The cut points follow the document's own structure rather than a character
 * count. A question and the text under it stay together; a marking-scheme entry
 * stays with its value points; a student's answer to one question is not
 * sliced in the middle of a derivation if it can be avoided. Only when a single
 * question is itself larger than a chunk is it split further, and then at its
 * sub-parts, then at paragraphs, then at lines — never inside a line.
 *
 * Every chunk carries where it came from: page range, the section heading in
 * force, and the question numbers whose headings appear in it. Those are hints
 * for the model and for whoever reads the audit trail. Attribution of content to
 * questions is done by the model reading the text, so an imperfect heading
 * guess moves a chunk boundary and nothing else.
 */

export interface ChunkLine {
  text: string;
  /** Zero-based page index. */
  page: number;
}

export interface DocumentChunk {
  index: number;
  total: number;
  text: string;
  startPage: number;
  endPage: number;
  /** The most recent "SECTION – E"-style heading before this chunk, if any. */
  section: string | null;
  /** Question numbers whose headings fall inside this chunk. */
  questionNumbers: number[];
  /** Set when one question had to be split across several chunks. */
  part: { index: number; count: number } | null;
  estimatedTokens: number;
  /** The lines this chunk was built from, kept so it can be split again. */
  lines: ChunkLine[];
}

export interface ChunkOptions {
  maxTokens: number;
  /**
   * Question numbers known to exist, from an earlier pass over the question
   * paper. When given, a line holding nothing but one of these numbers counts
   * as a heading — marking schemes often print the number alone in a column.
   */
  expectedNumbers?: number[];
}

interface Block {
  lines: ChunkLine[];
  questionNumber: number | null;
  section: string | null;
}

const SECTION_HEADING = /^\s*SECTION\s*[-–—:]?\s*([A-Z])\b/i;
/** "Q31", "Question 31", "Ques. 31", "Answer 3", "Ans 3". */
const PREFIXED_HEADING = /^\s*(?:Q(?:uestion)?|Ques|Ans(?:wer)?)\.?\s*(?:No\.?\s*)?(\d{1,3})\b/i;
/** "31." / "31)" / "(31)" followed by the question text. */
const NUMBERED_HEADING = /^\s*\(?(\d{1,3})\)?\s*[.):]\s+\S/;
const BARE_NUMBER = /^\s*(\d{1,3})\.?\s*$/;
/** "(a)", "(ii)", "b)" — the sub-parts of one question. */
const SUBPART_HEADING = /^\s*\(?(?:[a-h]|i{1,3}|iv|v|vi{1,3}|ix|x)\)\s*/i;

function toLines(pages: PageText[]): ChunkLine[] {
  const lines: ChunkLine[] = [];
  pages.forEach((page, index) => {
    for (const text of page.text.split('\n')) lines.push({ text, page: index });
  });
  return lines;
}

function tokensOf(lines: ChunkLine[]): number {
  return estimateTokens(lines.map((line) => line.text).join('\n'));
}

/**
 * Decides whether a line opens a new question.
 *
 * Without a list of expected numbers, headings must climb: a "1." that appears
 * after question 31 is a numbered list inside an answer, not a return to the
 * first question. With one, only those numbers count and each counts once.
 */
function headingNumber(
  line: string,
  seen: Set<number>,
  last: number | null,
  expected: Set<number> | null,
): number | null {
  const match =
    PREFIXED_HEADING.exec(line) ?? NUMBERED_HEADING.exec(line) ?? (expected ? BARE_NUMBER.exec(line) : null);
  if (!match) return null;

  const number = Number(match[1]);
  if (!Number.isFinite(number) || seen.has(number)) return null;

  if (expected) return expected.has(number) ? number : null;
  if (last !== null && (number <= last || number - last > 20)) return null;
  return number;
}

function toBlocks(lines: ChunkLine[], expected: Set<number> | null): Block[] {
  const blocks: Block[] = [];
  const seen = new Set<number>();
  let last: number | null = null;
  let section: string | null = null;
  let current: Block = { lines: [], questionNumber: null, section };

  for (const line of lines) {
    if (SECTION_HEADING.test(line.text)) {
      section = line.text.trim();
      // A block opened before any heading takes the first one it meets, so the
      // chunk built from it is labelled with the section it actually starts.
      if (current.questionNumber === null && current.section === null) current.section = section;
    }

    const number = headingNumber(line.text, seen, last, expected);
    if (number !== null) {
      if (current.lines.length > 0) blocks.push(current);
      seen.add(number);
      last = number;
      current = { lines: [], questionNumber: number, section };
    }
    current.lines.push(line);
  }
  if (current.lines.length > 0) blocks.push(current);

  return blocks;
}

/** Groups lines into runs that each start where `isBoundary` says. */
function splitAt(lines: ChunkLine[], isBoundary: (line: ChunkLine, index: number) => boolean): ChunkLine[][] {
  const runs: ChunkLine[][] = [];
  let run: ChunkLine[] = [];
  lines.forEach((line, index) => {
    if (isBoundary(line, index) && run.length > 0) {
      runs.push(run);
      run = [];
    }
    run.push(line);
  });
  if (run.length > 0) runs.push(run);
  return runs;
}

/** Greedily packs runs into groups of at most `maxTokens`, never splitting a run. */
function pack(runs: ChunkLine[][], maxTokens: number): ChunkLine[][] {
  const groups: ChunkLine[][] = [];
  let group: ChunkLine[] = [];
  let groupTokens = 0;

  for (const run of runs) {
    const runTokens = tokensOf(run);
    if (group.length > 0 && groupTokens + runTokens > maxTokens) {
      groups.push(group);
      group = [];
      groupTokens = 0;
    }
    group.push(...run);
    groupTokens += runTokens;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

/** A line longer than a whole chunk is cut at whitespace. It should not happen; it must not hang. */
function splitLongLine(line: ChunkLine, maxTokens: number): ChunkLine[] {
  const maxChars = Math.max(200, Math.floor(maxTokens * 3));
  const pieces: ChunkLine[] = [];
  let rest = line.text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut < maxChars / 2) cut = maxChars;
    pieces.push({ text: rest.slice(0, cut), page: line.page });
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) pieces.push({ text: rest, page: line.page });
  return pieces;
}

/**
 * Cuts a run of lines that is too big for one chunk, preferring the least
 * damaging boundary that gets every piece under the limit.
 */
function splitOversized(lines: ChunkLine[], maxTokens: number): ChunkLine[][] {
  const strategies: Array<(line: ChunkLine, index: number) => boolean> = [
    (line) => SUBPART_HEADING.test(line.text),
    (_line, index) => index > 0 && lines[index - 1]!.text.trim().length === 0,
    () => true,
  ];

  for (const isBoundary of strategies) {
    const runs = splitAt(lines, isBoundary);
    if (runs.length < 2) continue;
    if (runs.every((run) => tokensOf(run) <= maxTokens)) return pack(runs, maxTokens);
  }

  // Down to single lines and at least one is still too big.
  const shattered = lines.flatMap((line) =>
    tokensOf([line]) > maxTokens ? splitLongLine(line, maxTokens) : [line],
  );
  return pack(
    shattered.map((line) => [line]),
    maxTokens,
  );
}

function build(
  lines: ChunkLine[],
  section: string | null,
  questionNumbers: number[],
  part: DocumentChunk['part'],
): Omit<DocumentChunk, 'index' | 'total'> {
  const text = lines.map((line) => line.text).join('\n').trim();
  const pages = lines.map((line) => line.page);
  return {
    text,
    startPage: pages.length > 0 ? Math.min(...pages) : 0,
    endPage: pages.length > 0 ? Math.max(...pages) : 0,
    section,
    questionNumbers,
    part,
    estimatedTokens: estimateTokens(text),
    lines,
  };
}

function number(chunks: Array<Omit<DocumentChunk, 'index' | 'total'>>): DocumentChunk[] {
  const kept = chunks.filter((chunk) => chunk.text.length > 0);
  return kept.map((chunk, index) => ({ ...chunk, index, total: kept.length }));
}

export function chunkDocument(pages: PageText[], options: ChunkOptions): DocumentChunk[] {
  const { maxTokens } = options;
  const expected = options.expectedNumbers ? new Set(options.expectedNumbers) : null;
  const blocks = toBlocks(toLines(pages), expected);

  const out: Array<Omit<DocumentChunk, 'index' | 'total'>> = [];
  let pending: Block[] = [];
  let pendingTokens = 0;

  const flush = () => {
    if (pending.length === 0) return;
    const lines = pending.flatMap((block) => block.lines);
    const numbers = pending.map((block) => block.questionNumber).filter((n): n is number => n !== null);
    out.push(build(lines, pending[0]!.section, numbers, null));
    pending = [];
    pendingTokens = 0;
  };

  for (const block of blocks) {
    const blockTokens = tokensOf(block.lines);

    if (blockTokens > maxTokens) {
      // A single question larger than a chunk: finish what is pending, then
      // split this one on its own so its parts are labelled as parts.
      flush();
      const pieces = splitOversized(block.lines, maxTokens);
      pieces.forEach((piece, index) => {
        const numbers = block.questionNumber !== null ? [block.questionNumber] : [];
        out.push(build(piece, block.section, numbers, { index, count: pieces.length }));
      });
      continue;
    }

    if (pending.length > 0 && pendingTokens + blockTokens > maxTokens) flush();
    pending.push(block);
    pendingTokens += blockTokens;
  }
  flush();

  return number(out);
}

/**
 * Splits one chunk into smaller ones, for when the provider still refuses it.
 * The estimate is pessimistic, so this is rare; when it happens the chunk's own
 * lines are cut at the same boundaries the first pass would have used.
 */
export function splitChunk(chunk: DocumentChunk, maxTokens: number): DocumentChunk[] {
  const pieces = splitOversized(chunk.lines, maxTokens);
  if (pieces.length < 2) {
    // Nothing structural to cut at; halve it by lines.
    const middle = Math.ceil(chunk.lines.length / 2);
    if (middle === 0 || middle === chunk.lines.length) return [chunk];
    pieces.splice(0, pieces.length, chunk.lines.slice(0, middle), chunk.lines.slice(middle));
  }
  return number(
    pieces.map((piece, index) =>
      build(piece, chunk.section, chunk.questionNumbers, { index, count: pieces.length }),
    ),
  );
}

/**
 * Splits plain text — one student's answer — into passages under `maxTokens`,
 * cutting at sub-parts, then paragraphs, then lines. Used when a single answer
 * is too long to grade in one request.
 */
export function splitText(text: string, maxTokens: number): string[] {
  const lines: ChunkLine[] = text.split('\n').map((line) => ({ text: line, page: 0 }));
  if (tokensOf(lines) <= maxTokens) return [text];
  return splitOversized(lines, maxTokens)
    .map((piece) => piece.map((line) => line.text).join('\n').trim())
    .filter((piece) => piece.length > 0);
}
