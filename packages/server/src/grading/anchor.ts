import type { AnchorStatus, PageText, Rect, TextRun } from '@gradesense/shared';
import { groundRegion } from './diagram.js';
import { normalise, tokenise, windowSimilarity } from './text-match.js';

/**
 * Turning a quote back into rectangles on the page.
 *
 * The model returns evidence as a span of the student's prose. To underline that
 * span we have to find it in the extracted text and translate its character
 * range into page geometry. Three things make that harder than a substring
 * search:
 *
 *  1. Whitespace and punctuation never survive a round trip through a PDF text
 *     layer intact, so matching happens on a normalised copy that carries an
 *     index back to the original offsets.
 *  2. A scanned answer may be full of OCR damage ("currenl" for "current"), so
 *     an exact match failing does not mean the quote is absent. A token-level
 *     fuzzy pass catches those.
 *  3. PDF producers emit a whole line as one positioned run, so a phrase inside
 *     a line has no rectangle of its own. Its box is interpolated across the
 *     line using per-character widths.
 *
 * When all of that fails we report `unresolved` rather than pointing at
 * something arbitrary. A wrong underline is worse than an honest margin note.
 */

/** Below this token-similarity, a fuzzy match is not trustworthy enough to draw. */
const FUZZY_ACCEPT_THRESHOLD = 0.74;
/** Quotes shorter than this are too generic to anchor safely. */
const MIN_QUOTE_CHARS = 8;

export interface AnchorResult {
  status: AnchorStatus;
  similarity: number;
  matchedText: string | null;
  rects: Rect[];
  /**
   * True when the rectangles come from a vision model's estimate of where a
   * transcribed line sits, rather than from the PDF's own text layer. Right to
   * within a line or so, not to the word; shown and scored as approximate.
   */
  approximatePosition: boolean;
}

const UNRESOLVED: AnchorResult = { status: 'unresolved', similarity: 0, matchedText: null, rects: [], approximatePosition: false };

/* ----------------------------- character widths ---------------------------- */

/**
 * Rough advance widths, relative to an em, for the base-14 serif faces the
 * answer papers use. Interpolating a phrase's box with these is visibly better
 * than assuming every character is the same width — "illiterate" and "WWWWW"
 * are not close to equal in a proportional font.
 */
const NARROW = new Set("ijltfrI.,;:'`|!()[]-");
const WIDE = new Set('mwMW@%&');
const CAPITALS = new Set('ABCDEFGHJKLNOPQRSTUVXYZ');

function charWidth(ch: string): number {
  if (ch === ' ') return 0.25;
  if (NARROW.has(ch)) return 0.3;
  if (WIDE.has(ch)) return 0.85;
  if (CAPITALS.has(ch)) return 0.68;
  if (/[0-9]/.test(ch)) return 0.5;
  return 0.48;
}

function measure(text: string): number {
  let total = 0;
  for (const ch of text) total += charWidth(ch);
  return total;
}

/* ------------------------------ rect building ------------------------------ */

/**
 * Slices a run's rectangle down to the portion covering `[from, to)` of the
 * source text, so a phrase inside a line gets a phrase-sized box.
 */
function sliceRunRect(run: TextRun, from: number, to: number): Rect {
  const localFrom = Math.max(0, from - run.start);
  const localTo = Math.min(run.text.length, to - run.start);

  if (localFrom <= 0 && localTo >= run.text.length) return run.rect;

  const totalWidth = measure(run.text);
  if (totalWidth <= 0) return run.rect;

  const before = measure(run.text.slice(0, localFrom));
  const covered = measure(run.text.slice(localFrom, localTo));

  const x = run.rect.x + run.rect.width * (before / totalWidth);
  const width = run.rect.width * (covered / totalWidth);

  return {
    page: run.rect.page,
    x: Math.min(1, Math.max(0, x)),
    y: run.rect.y,
    width: Math.min(1 - Math.min(1, Math.max(0, x)), Math.max(0.002, width)),
    height: run.rect.height,
  };
}

/**
 * Collects one rectangle per line the span touches. A quote that wraps across
 * three lines becomes three boxes, which is how a teacher would underline it.
 */
function rectsForRange(page: PageText, from: number, to: number): Rect[] {
  const rects: Rect[] = [];
  for (const run of page.runs) {
    if (run.end <= from || run.start >= to) continue;
    rects.push(sliceRunRect(run, from, to));
  }
  return mergeAdjacent(rects);
}

/** Merges boxes that sit on the same visual line so one line yields one box. */
function mergeAdjacent(rects: Rect[]): Rect[] {
  const merged: Rect[] = [];
  for (const rect of rects) {
    const previous = merged[merged.length - 1];
    const sameLine =
      previous !== undefined &&
      previous.page === rect.page &&
      Math.abs(previous.y - rect.y) < 0.004 &&
      rect.x - (previous.x + previous.width) < 0.02;

    if (sameLine && previous) {
      const right = Math.max(previous.x + previous.width, rect.x + rect.width);
      previous.width = right - previous.x;
      previous.height = Math.max(previous.height, rect.height);
    } else {
      merged.push({ ...rect });
    }
  }
  return merged;
}

/* --------------------------------- matching -------------------------------- */

interface PageMatch {
  page: PageText;
  from: number;
  to: number;
  similarity: number;
  status: Extract<AnchorStatus, 'exact' | 'fuzzy'>;
}

function findInPage(page: PageText, quote: string): PageMatch | null {
  const pageNorm = normalise(page.text);
  const quoteNorm = normalise(quote);
  if (quoteNorm.norm.length === 0 || pageNorm.norm.length === 0) return null;

  // 1. Exact match on the normalised text.
  const exactIndex = pageNorm.norm.indexOf(quoteNorm.norm);
  if (exactIndex >= 0) {
    const from = pageNorm.map[exactIndex]!;
    const lastNormIndex = exactIndex + quoteNorm.norm.length - 1;
    const to = pageNorm.map[lastNormIndex]! + 1;
    return { page, from, to, similarity: 1, status: 'exact' };
  }

  // 2. Token-window fuzzy match, for OCR damage and light paraphrase.
  const pageTokens = tokenise(pageNorm.norm);
  const quoteTokens = tokenise(quoteNorm.norm);
  if (quoteTokens.length === 0 || pageTokens.length < quoteTokens.length) return null;

  let best: { offset: number; similarity: number } | null = null;
  const lastOffset = pageTokens.length - quoteTokens.length;
  for (let offset = 0; offset <= lastOffset; offset += 1) {
    const similarity = windowSimilarity(quoteTokens, pageTokens, offset);
    if (!best || similarity > best.similarity) best = { offset, similarity };
    if (similarity === 1) break;
  }

  if (!best || best.similarity < FUZZY_ACCEPT_THRESHOLD) return null;

  const firstToken = pageTokens[best.offset]!;
  const lastToken = pageTokens[best.offset + quoteTokens.length - 1]!;
  const from = pageNorm.map[firstToken.start]!;
  const to = pageNorm.map[lastToken.end - 1]! + 1;

  return { page, from, to, similarity: best.similarity, status: 'fuzzy' };
}

/**
 * Locates a quote across every page and returns its rectangles.
 *
 * `pageHint` biases the search: a finding the model attached to page 1 is
 * checked there first, but a match on another page still wins over no match,
 * because the page number is the least reliable thing the model tells us.
 */
export function anchorQuote(quote: string | null, pages: PageText[], pageHint?: number): AnchorResult {
  if (!quote) return UNRESOLVED;
  const trimmed = quote.trim();
  if (trimmed.length < MIN_QUOTE_CHARS) return UNRESOLVED;

  const ordered = [...pages].sort((a, b) => {
    if (pageHint === undefined) return a.index - b.index;
    const aScore = a.index === pageHint ? -1 : a.index;
    const bScore = b.index === pageHint ? -1 : b.index;
    return aScore - bScore;
  });

  let best: PageMatch | null = null;
  for (const page of ordered) {
    const match = findInPage(page, trimmed);
    if (match && (!best || match.similarity > best.similarity)) {
      best = match;
      if (match.status === 'exact') break;
    }
  }

  if (!best) return UNRESOLVED;

  const rects = rectsForRange(best.page, best.from, best.to);

  /*
   * A transcribed page has text but no runs, so a quote can be found in it and
   * still have nowhere to be drawn. That is a verified quote without a
   * rectangle — the caller shows it as a margin note — not a quote that is
   * absent. Conflating the two would mark every citation on a scanned sheet as
   * unverified, and drag its confidence down for a reason that is not real.
   * A page that does have runs but yields no rectangle is still unresolved, as
   * before: there the geometry should have worked, and its failure is a signal.
   */
  if (rects.length === 0 && best.page.runs.length > 0) return UNRESOLVED;

  return {
    status: best.status,
    similarity: Number(best.similarity.toFixed(4)),
    matchedText: best.page.text.slice(best.from, best.to),
    rects,
    approximatePosition: rects.length > 0 && best.page.source === 'transcription',
  };
}

/**
 * Turns a model-supplied region into the drawing it was pointing at.
 *
 * Bounding boxes are the least reliable thing a language model produces. Drawn
 * as given they are visibly wrong: a box that frames most of a circuit but cuts
 * off the ammeter, or a sliver standing beside one number on a graph's axis.
 * Clamping them to the page made them legal without making them right.
 *
 * So the box is not drawn. It is used only to choose which drawing on the page
 * the finding is about, and the rectangle that gets drawn is the one measured
 * from that drawing's own labels — exact, and the same every run. When the box
 * points at no drawing at all we report `unresolved` and let it become a margin
 * note, because a rectangle across blank paper claims a precision we do not
 * have.
 */
export function anchorRegion(
  region: { page: number; x: number; y: number; width: number; height: number } | null,
  pages: PageText[],
): AnchorResult {
  if (!region) return UNRESOLVED;

  const pageIndex = Math.min(Math.max(0, Math.trunc(region.page)), Math.max(0, pages.length - 1));
  const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

  const x = clamp01(region.x);
  const y = clamp01(region.y);
  const box: Rect = {
    page: pageIndex,
    x,
    y,
    width: Math.min(1 - x, Math.max(0, clamp01(region.width))),
    height: Math.min(1 - y, Math.max(0, clamp01(region.height))),
  };

  const drawing = groundRegion(box, pages);
  if (!drawing) return UNRESOLVED;

  return {
    status: 'region',
    approximatePosition: false,
    similarity: 0,
    matchedText: null,
    rects: [
      {
        page: drawing.page,
        x: drawing.x,
        y: drawing.y,
        width: drawing.width,
        height: drawing.height,
      },
    ],
  };
}

/**
 * Where to park an annotation that could not be placed: the right margin,
 * beside the top of the question it belongs to. Visibly a margin note rather
 * than a claim about a specific word.
 */
export function marginNoteRect(pageIndex: number, slot: number): Rect {
  const perPage = 9;
  const index = slot % perPage;
  return {
    page: Math.max(0, pageIndex),
    x: 0.8,
    y: 0.08 + index * 0.095,
    width: 0.17,
    height: 0.055,
  };
}
