import type { PageText, Rect, TextRun } from '@gradesense/shared';

/**
 * Finding the drawings on a page by measuring, not by asking.
 *
 * A model that is shown a page can say roughly where a diagram sits, but only
 * roughly: bounding boxes are the least reliable thing a language model
 * produces, and a box that is nearly right is still a red rectangle drawn
 * across the wrong part of a student's paper.
 *
 * A drawing's labels, though, are text, and text has coordinates. "battery",
 * "switch", "voltmeter" and "ameter" are in the PDF's text layer with exact
 * rectangles, so the extent of the circuit they label can be measured to the
 * point. That measurement is deterministic, costs nothing, and is right every
 * time — so it is what actually gets drawn. The model's box is demoted to what
 * it is good at: choosing *which* drawing a finding is about.
 *
 * The discriminator between a drawing's labels and ordinary prose is the left
 * margin. Body text on any page starts at one of a handful of x positions and
 * runs most of the width of the page. Labels sit wherever the thing they name
 * happens to be, and are short. A run that is short and does not start on a
 * body margin is part of a drawing — and one that does start there is still a
 * label if it has clear paper above and below it, because body lines come in
 * stacks and a label written beside an arrow does not.
 */

/** A run at least this wide is a full line of body text, and defines a margin. */
const PROSE_MIN_WIDTH = 0.5;
/** A run wider than this is prose, not a label on a drawing. */
const LABEL_MAX_WIDTH = 0.3;
/** How close to a body margin a run must start to count as body text. */
const MARGIN_TOLERANCE = 0.012;
/**
 * Vertical gap between labels that still belongs to one drawing. Generous on
 * purpose: a circuit's top row of labels and the meter below it can be a long
 * way apart, and it is the prose between two drawings — not the distance — that
 * really tells them apart.
 */
const MAX_LABEL_GAP = 0.25;
/** A band shorter than this is a line of text that happens to be in columns. */
const MIN_BAND_HEIGHT = 0.05;
/** A single stray short run is not a drawing. */
const MIN_BAND_LABELS = 2;
/** An x position shared by this many runs is a margin, even without wide prose. */
const MARGIN_MIN_RUNS = 3;
/** How far above a drawing its caption may sit. */
const CAPTION_MAX_GAP = 0.05;
const CAPTION_MAX_WIDTH = 0.35;
const CAPTION_PATTERN = /\b(diagram|graph|figure|fig|sketch|drawing|chart|plot)\b/i;
/** An answer or question heading always ends a drawing, whatever its width. */
const HEADING_PATTERN = /^(answer|question|q)\s*\d/i;
/** Two body lines sit no further apart than this. */
const LINE_SPACING = 0.03;
/** Breathing room so the box frames the drawing instead of clipping its wires. */
const PAD = 0.015;
/**
 * A model box that misses every drawing but lands this close to one was aiming
 * at it. Further away than this and we do not know what it meant.
 */
const NEAR_DISTANCE = 0.15;

export interface DiagramRegion extends Rect {
  /** The drawing's caption, when it has one. Used to tell two drawings apart. */
  caption: string | null;
}

function bottom(rect: Rect): number {
  return rect.y + rect.height;
}

function right(rect: Rect): number {
  return rect.x + rect.width;
}

/**
 * The x positions where this page's body text starts.
 *
 * A full-width line is unambiguously prose and its left edge is a margin. That
 * alone is not enough, though: a page holding only headings — a blank answer
 * sheet, or a page carrying nothing but a drawing — has no full-width line at
 * all, and with no margins every short run on it would look like a label. So a
 * position several runs share counts as a margin too.
 */
function bodyMargins(runs: TextRun[]): number[] {
  const margins: number[] = [];
  const add = (x: number) => {
    if (!margins.some((margin) => Math.abs(margin - x) <= MARGIN_TOLERANCE)) margins.push(x);
  };

  for (const run of runs) {
    if (run.rect.width >= PROSE_MIN_WIDTH) add(run.rect.x);
  }
  if (margins.length > 0) return margins;

  // Only reached on a page with no full-width line at all — a blank answer
  // sheet, or a page carrying nothing but a drawing. Sharing a left edge is a
  // weaker signal than being a line of prose, so it is the last resort rather
  // than an equal partner: on an ordinary page it would mistake a column of
  // stacked diagram labels for a margin.
  for (const run of runs) {
    if (run.text.trim().length === 0) continue;
    const shared = runs.filter(
      (other) =>
        other.text.trim().length > 0 && Math.abs(other.rect.x - run.rect.x) <= MARGIN_TOLERANCE,
    );
    if (shared.length >= MARGIN_MIN_RUNS) add(run.rect.x);
  }

  return margins;
}

function onMargin(run: TextRun, margins: number[]): boolean {
  return margins.some((margin) => Math.abs(margin - run.rect.x) <= MARGIN_TOLERANCE);
}

/**
 * Whether a margin-aligned run is part of the running text.
 *
 * Body lines come in stacks: a paragraph's last line is short, but it always has
 * another line directly above it. A label that happens to sit at the left edge
 * of a drawing — "conventional current", written beside an arrow — has clear
 * paper above and below it, which is what gives it away.
 */
function inTextFlow(run: TextRun, runs: TextRun[], margins: number[]): boolean {
  return runs.some((other) => {
    if (other === run || other.text.trim().length === 0) return false;
    if (!onMargin(other, margins)) return false;
    const gap = Math.max(other.rect.y - bottom(run.rect), run.rect.y - bottom(other.rect));
    return gap <= LINE_SPACING;
  });
}

function isLabel(run: TextRun, runs: TextRun[], margins: number[]): boolean {
  const text = run.text.trim();
  if (text.length === 0) return false;
  if (run.rect.width > LABEL_MAX_WIDTH) return false;
  // A caption names the drawing rather than sitting inside it, so it bounds the
  // band instead of belonging to it — even when it is not margin-aligned.
  if (CAPTION_PATTERN.test(text)) return false;
  // The next answer's heading always ends the drawing above it.
  if (HEADING_PATTERN.test(text)) return false;
  if (!onMargin(run, margins)) return true;
  return !inTextFlow(run, runs, margins);
}

/**
 * The caption sitting just above a drawing, if there is one.
 *
 * Captions are margin-aligned like prose, so they are not labels — but they
 * name the drawing, which is how a rule that means "the circuit" can be told
 * apart from one that means "the graph".
 */
function captionAbove(runs: TextRun[], top: number): TextRun | null {
  let best: TextRun | null = null;
  for (const run of runs) {
    const text = run.text.trim();
    if (text.length === 0 || run.rect.width > CAPTION_MAX_WIDTH) continue;
    if (!CAPTION_PATTERN.test(text)) continue;

    const gap = top - bottom(run.rect);
    if (gap < 0 || gap > CAPTION_MAX_GAP) continue;
    if (!best || bottom(run.rect) > bottom(best.rect)) best = run;
  }
  return best;
}

function boxOf(page: number, rects: Rect[], caption: string | null): DiagramRegion {
  const left = Math.max(0, Math.min(...rects.map((rect) => rect.x)) - PAD);
  const top = Math.max(0, Math.min(...rects.map((rect) => rect.y)) - PAD);
  const far = Math.min(1, Math.max(...rects.map(right)) + PAD);
  const low = Math.min(1, Math.max(...rects.map(bottom)) + PAD);

  return { page, caption, x: left, y: top, width: far - left, height: low - top };
}

/**
 * Every drawing on one page, measured from the labels inside it.
 *
 * Labels are grouped into vertical bands: a run of labels with no large gap
 * between them is one drawing. A band has to be tall enough and hold enough
 * labels to be a drawing at all, which is what stops a page header — three
 * short runs side by side — from being reported as a diagram.
 */
export function findDiagramRegions(page: PageText): DiagramRegion[] {
  const margins = bodyMargins(page.runs);
  const labels = page.runs
    .filter((run) => isLabel(run, page.runs, margins))
    .sort((a, b) => a.rect.y - b.rect.y);

  if (labels.length === 0) return [];

  /*
   * Prose is what separates one drawing from the next. Two labels with a line of
   * body text between them belong to different things however close together
   * they are, and two labels at opposite ends of a drawing belong to the same
   * thing however far apart — which is why the gap alone was never the test.
   */
  const separators = page.runs.filter(
    (run) => run.text.trim().length > 0 && !isLabel(run, page.runs, margins),
  );
  const separatorBetween = (from: number, to: number) =>
    separators.some((run) => run.rect.y >= from && bottom(run.rect) <= to);

  const bands: TextRun[][] = [];
  let current: TextRun[] = [];
  let reach = -Infinity;

  for (const label of labels) {
    const broken =
      current.length > 0 &&
      (label.rect.y - reach > MAX_LABEL_GAP || separatorBetween(reach, label.rect.y));

    if (broken) {
      bands.push(current);
      current = [];
      reach = -Infinity;
    }
    current.push(label);
    reach = Math.max(reach, bottom(label.rect));
  }
  if (current.length > 0) bands.push(current);

  const regions: DiagramRegion[] = [];
  for (const band of bands) {
    if (band.length < MIN_BAND_LABELS) continue;

    const rects = band.map((run) => run.rect);
    const top = Math.min(...rects.map((rect) => rect.y));
    const low = Math.max(...rects.map(bottom));
    if (low - top < MIN_BAND_HEIGHT) continue;

    // The caption is part of the drawing: including it frames the thing the way
    // a teacher would circle it, and its left edge catches an axis drawn to the
    // left of every label on it.
    const caption = captionAbove(page.runs, top);
    const framed = caption ? [...rects, caption.rect] : rects;
    regions.push(boxOf(page.index, framed, caption ? caption.text.trim() : null));
  }

  return regions;
}

/** Every drawing in the document. */
export function findAllDiagramRegions(pages: PageText[]): DiagramRegion[] {
  return pages.flatMap((page) => findDiagramRegions(page));
}

/** The drawing whose caption matches, searched across the whole document. */
export function findDiagramByCaption(pages: PageText[], caption: string): DiagramRegion | null {
  const wanted = caption.trim().toLowerCase();
  return (
    findAllDiagramRegions(pages).find((region) => region.caption?.toLowerCase() === wanted) ?? null
  );
}

function intersectionArea(a: Rect, b: Rect): number {
  const width = Math.min(right(a), right(b)) - Math.max(a.x, b.x);
  const height = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/** Vertical distance between two boxes; zero when they overlap on that axis. */
function verticalGap(a: Rect, b: Rect): number {
  if (bottom(a) < b.y) return b.y - bottom(a);
  if (bottom(b) < a.y) return a.y - bottom(b);
  return 0;
}

/**
 * Replaces a model's approximate box with the measured drawing it was pointing
 * at.
 *
 * Overlap decides which drawing is meant, because a box that is roughly right
 * still lands on the thing it describes. A box that touches no drawing but sits
 * just outside one was aiming at it and missed, so it snaps. A box that is
 * nowhere near any drawing gets nothing back: we do not know what it meant, and
 * an honest margin note beats a rectangle drawn across blank paper.
 */
export function groundRegion(box: Rect, pages: PageText[]): DiagramRegion | null {
  const page = pages.find((candidate) => candidate.index === box.page);
  if (!page) return null;

  const regions = findDiagramRegions(page);
  if (regions.length === 0) return null;

  let overlapping: DiagramRegion | null = null;
  let overlap = 0;
  for (const region of regions) {
    const area = intersectionArea(box, region);
    if (area > overlap) {
      overlap = area;
      overlapping = region;
    }
  }
  if (overlapping) return overlapping;

  let nearest: DiagramRegion | null = null;
  let distance = Infinity;
  for (const region of regions) {
    const gap = verticalGap(box, region);
    if (gap < distance) {
      distance = gap;
      nearest = region;
    }
  }

  return distance <= NEAR_DISTANCE ? nearest : null;
}
