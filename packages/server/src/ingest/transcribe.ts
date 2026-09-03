import { z } from 'zod';
import type { IngestedDocument, PageText, TextRun, TranscriptionInfo } from '@gradesense/shared';
import { RequestTooLargeError } from '../errors.js';
import type { GradingModel } from '../grading/model.js';
import { isTransientModelError } from '../grading/providers/transient.js';
import type { Repository } from '../store/repository.js';
import { renderPages, type InkRow } from './render.js';

/**
 * Reading scanned handwriting into text the rest of the pipeline can use.
 *
 * A photographed or scanned answer sheet arrives as a PDF whose pages are
 * pictures. The text extractor finds nothing on them, and before this existed
 * every question on such a sheet was scored as unanswered without a model ever
 * being asked — a confident zero for a full answer. The fix is not to trust OCR
 * blindly but to have a vision model read each page as an examiner's assistant
 * would: copying what is written exactly, line by line with the place each line
 * occupies, describing every drawing with its labels, and saying plainly what
 * it could not read.
 *
 * The transcript replaces the empty page text, so segmentation, evidence
 * quoting and the token budget all work unchanged. Each line's box becomes a
 * text run, so a quote from the transcript can be drawn beside the line it came
 * from — approximately, and labelled as such — instead of stacking in the
 * margin. Pages are marked `source: 'transcription'` so every downstream
 * consumer knows the text is a reading of handwriting and not the handwriting
 * itself. Typed PDFs never come through here: a page with a real text layer
 * keeps it.
 */

/** A page with fewer legible characters than this is treated as having no text layer. */
const MIN_TEXT_LAYER_CHARS = 20;
/** How much of the previous page's transcript is shown for continuity. */
const PREVIOUS_TAIL_CHARS = 300;

const BoxSchema = { top: z.number(), bottom: z.number(), left: z.number(), right: z.number() };

export const PageTranscriptOutputSchema = z.object({
  lines: z.array(z.object({ text: z.string(), ...BoxSchema })),
  diagrams: z.array(z.object({ marker: z.number().int(), description: z.string(), labels: z.array(z.string()), ...BoxSchema })),
  unclear: z.array(z.string()),
  struck: z.array(z.string()),
  questionNumbers: z.array(z.number().int()),
  legibility: z.enum(['good', 'fair', 'poor']),
});
export type PageTranscriptOutput = z.infer<typeof PageTranscriptOutputSchema>;

/** A box in page fractions, 0,0 top-left to 1,1 bottom-right. */
export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** One line of the transcript as the grader will read it, with where it sits. */
export interface PositionedLine {
  text: string;
  box: Box | null;
}

/** Zero-based indices of the pages whose text layer is missing or negligible. */
export function pagesNeedingTranscription(document: IngestedDocument): number[] {
  return document.pages
    .filter((page) => {
      if (page.source === 'transcription') return false;
      const legible = page.text.replace(/[^\p{L}\p{N}]/gu, '');
      return legible.length < MIN_TEXT_LAYER_CHARS;
    })
    .map((page) => page.index);
}

export function needsTranscription(document: IngestedDocument): boolean {
  if (document.transcription?.status === 'done') return false;
  return pagesNeedingTranscription(document).length > 0;
}

export interface TranscribeInput {
  document: IngestedDocument;
  bytes: Buffer;
  model: GradingModel;
  maxAttempts: number;
  retryBaseDelayMs: number;
  onPage?: (pageIndex: number, total: number) => void;
}

interface PendingPage {
  index: number;
  width: number;
  height: number;
  lines: PositionedLine[];
}

/**
 * Transcribes every page that needs it and returns the document with those
 * pages' text replaced. The original bytes are never touched.
 *
 * Pages go one at a time, in order, each shown the tail of the previous
 * transcript so working that runs over a page break is continued rather than
 * restarted. A provider that cannot read images gets a document marked
 * `unsupported` rather than an exception: the caller decides what that means,
 * and the grading pipeline turns it into a review reason instead of a silent
 * zero.
 */
export async function transcribeDocument(input: TranscribeInput): Promise<IngestedDocument> {
  const { document, bytes, model } = input;
  const targets = pagesNeedingTranscription(document);
  if (targets.length === 0) return document;

  const stamp = () => new Date().toISOString();

  if (!model.transcribePage) {
    return withTranscription(document, {
      status: 'unsupported',
      pages: targets,
      provider: model.providerName,
      model: null,
      at: stamp(),
      legibility: null,
      unclear: [],
      error: `The ${model.providerName} provider cannot read images, so the scanned pages could not be transcribed.`,
    });
  }

  const rendered = await renderPages(bytes, { pageIndices: targets });
  const byIndex = new Map(document.pages.map((page) => [page.index, page]));
  const pending: PendingPage[] = [];
  const unclear: string[] = [];
  const legibilities: Array<'good' | 'fair' | 'poor'> = [];
  const reportedNumbers: number[] = [];
  let previousTail: string | null = null;

  for (const image of rendered) {
    input.onPage?.(image.index, rendered.length);

    const output = await transcribeOnePage({
      model,
      imageBase64: image.jpeg.toString('base64'),
      pageIndex: image.index,
      pageCount: document.pageCount,
      previousTail,
      maxAttempts: input.maxAttempts,
      retryBaseDelayMs: input.retryBaseDelayMs,
      bytes,
    });

    const lines = snapLinesToInk(composeLines(output), image.inkRows);
    const existing = byIndex.get(image.index);
    pending.push({ index: image.index, width: existing?.width ?? image.width, height: existing?.height ?? image.height, lines });

    unclear.push(...output.unclear);
    legibilities.push(output.legibility);
    reportedNumbers.push(...output.questionNumbers);
    const text = lines.map((line) => line.text).join('\n');
    previousTail = text.length > PREVIOUS_TAIL_CHARS ? text.slice(-PREVIOUS_TAIL_CHARS) : text;
  }

  // A number the transcriber saw on any page is expected on every page: a
  // heading it misread on one page is usually reported correctly on another.
  const allNumbers = [...new Set(reportedNumbers)];
  for (const page of pending) {
    const lines = page.lines.map((line) => ({ ...line, text: normaliseHeadings(line.text, allNumbers) }));
    byIndex.set(page.index, buildPageText(page.index, page.width, page.height, lines));
  }

  const pages = [...byIndex.values()].sort((a, b) => a.index - b.index);
  const transcribed: IngestedDocument = {
    ...document,
    pages,
    fullText: pages.map((page) => page.text).join('\n\f\n'),
  };

  return withTranscription(transcribed, {
    status: 'done',
    pages: targets,
    provider: model.providerName,
    model: visionModelName(model),
    at: stamp(),
    legibility: worstLegibility(legibilities),
    unclear,
    error: null,
  });
}

/* ------------------------------ page assembly ------------------------------ */

const DIAGRAM_MARKER = /\[\s*diagram\s*(\d+)\s*\]/gi;
const MARKER_LINE = /^\s*\[\s*diagram\s*(\d+)\s*\]\s*$/i;

/**
 * The transcriber's coordinates, whatever scale it used, as page fractions.
 *
 * It is asked for 0–1000, and usually complies; fractions and raw pixels are
 * recognised anyway. A box that is empty, inverted or off the page is dropped —
 * a missing box costs a margin note, a wrong box points a teacher at the wrong
 * line.
 */
export function normaliseBox(raw: Box, imageWidth = 0, imageHeight = 0): Box | null {
  const values = [raw.top, raw.bottom, raw.left, raw.right];
  if (values.some((value) => !Number.isFinite(value))) return null;
  const max = Math.max(...values);
  let divX = 1;
  let divY = 1;
  if (max > 1.001) {
    if (max <= 1000.5) {
      divX = divY = 1000;
    } else if (imageWidth > 0 && imageHeight > 0) {
      divX = imageWidth;
      divY = imageHeight;
    } else {
      return null;
    }
  }
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const box = {
    top: clamp(raw.top / divY),
    bottom: clamp(raw.bottom / divY),
    left: clamp(raw.left / divX),
    right: clamp(raw.right / divX),
  };
  if (box.bottom - box.top < 0.002 || box.right - box.left < 0.002) return null;
  return box;
}

/** Marker numbers placed in the lines that have no description to go with them. */
export function undescribedDiagramMarkers(output: PageTranscriptOutput): number[] {
  const described = new Set(output.diagrams.map((diagram) => diagram.marker));
  const markers = output.lines.flatMap((line) => [...line.text.matchAll(DIAGRAM_MARKER)].map((match) => Number(match[1])));
  return [...new Set(markers.filter((marker) => !described.has(marker)))];
}

/**
 * Lays the transcript out as the grader will read it: the diagram markers are
 * expanded in place into their descriptions and labels, so a drawing appears
 * where the student drew it rather than in a footnote, and a diagram line takes
 * the drawing's own box so a finding about it frames the drawing. A marker the
 * transcriber placed but never described is kept, and says so — the grader
 * must know there is a drawing it cannot read rather than think the student
 * drew nothing.
 */
export function composeLines(output: PageTranscriptOutput): PositionedLine[] {
  const diagrams = new Map(output.diagrams.map((diagram) => [diagram.marker, diagram]));
  const placed = new Set<number>();
  const lines: PositionedLine[] = [];

  for (const raw of output.lines) {
    const box = normaliseBox(raw);
    let text = raw.text.replace(/\r\n/g, '\n').trimEnd();
    let lineBox = box;
    text = text.replace(DIAGRAM_MARKER, (_match, number: string) => {
      const marker = Number(number);
      const diagram = diagrams.get(marker);
      placed.add(marker);
      if (!diagram) {
        return marker === 0
          ? '[Diagram: one or more drawings are present here but could not be described — do not assume what they show]'
          : `[Diagram ${marker}: a drawing is present here but could not be described — do not assume what it shows]`;
      }
      lineBox = normaliseBox(diagram) ?? lineBox;
      return expandDiagram(diagram);
    });
    lines.push({ text, box: lineBox });
  }

  // A described diagram whose marker the model forgot to place still belongs on the page.
  for (const diagram of output.diagrams) {
    if (placed.has(diagram.marker)) continue;
    lines.push({ text: expandDiagram(diagram), box: normaliseBox(diagram) });
  }

  return lines.filter((line, index) => line.text.trim().length > 0 || index < lines.length - 1);
}

function expandDiagram(diagram: PageTranscriptOutput['diagrams'][number]): string {
  const labels = diagram.labels.length > 0 ? ` Labels: ${diagram.labels.join(' | ')}.` : '';
  return `[Diagram ${diagram.marker}: ${diagram.description.trim()}${labels}]`;
}

/** The page as plain text, for callers and tests that only need the words. */
export function composePageText(output: PageTranscriptOutput): string {
  return composeLines(output).map((line) => line.text).join('\n').trim();
}

/** Below this share of lines in top-to-bottom order, the boxes are noise and are dropped. */
const MIN_ORDERED_SHARE = 0.7;

/**
 * Turns positioned lines into a page whose runs the anchoring code can use.
 *
 * Each line with a box becomes one run covering the whole line. The boxes are
 * a vision model's estimate, so they are checked for the one property that is
 * easy to verify — lines on a page run from top to bottom — and if too many
 * break it the page keeps its text but loses its positions, and its
 * annotations become margin notes as before.
 */
export function buildPageText(index: number, width: number, height: number, lines: PositionedLine[]): PageText {
  const boxed = lines.filter((line) => line.box !== null);
  let ordered = 0;
  for (let i = 1; i < boxed.length; i += 1) {
    if (boxed[i]!.box!.top >= boxed[i - 1]!.box!.top - 0.02) ordered += 1;
  }
  const trustPositions = boxed.length > 0 && (boxed.length < 2 || ordered / (boxed.length - 1) >= MIN_ORDERED_SHARE);

  let text = '';
  const runs: TextRun[] = [];
  lines.forEach((line, position) => {
    if (position > 0) text += '\n';
    const start = text.length;
    text += line.text;
    if (trustPositions && line.box && line.text.trim().length > 0) {
      runs.push({
        text: line.text,
        start,
        end: text.length,
        rect: {
          page: index,
          x: line.box.left,
          y: line.box.top,
          width: Math.max(0.002, line.box.right - line.box.left),
          height: Math.max(0.002, line.box.bottom - line.box.top),
        },
      });
    }
  });

  return { index, width, height, text: text.trim(), runs, source: 'transcription' };
}

/** A model coordinate further than this from a row is not evidence for that row at all. */
const MAX_COORDINATE_GAP = 0.25;
/** Cost of leaving a line without a row, or a row without a line, in the alignment. */
const SKIP_COST = 0.3;
/** A box taller than this is a drawing, not a line of text. */
const MAX_TEXT_LINE_HEIGHT = 0.12;

/**
 * Places each transcribed line on the row of ink it belongs to.
 *
 * The vision model's coordinates are poor — quantised, drifting down the page
 * by a tenth or more, sometimes absent — but its *order* is reliable, and so is
 * the order of the ink rows found in the pixels. So the two sequences are
 * aligned as sequences: each text line is paired with a row so that order is
 * preserved and the pairing stays close to the diagonal (the i-th line goes
 * near the i-th row), with the model's coordinate breaking ties when it is not
 * absurdly far off. Rows inside a drawing's box belong to the drawing and are
 * kept out of the alignment; the drawing itself tightens to the rows it covers.
 * A line the alignment leaves unmatched keeps whatever box the model gave it.
 */
export function snapLinesToInk(lines: PositionedLine[], rows: InkRow[]): PositionedLine[] {
  if (rows.length === 0) return lines;

  const isDiagram = (line: PositionedLine) => /^\s*\[Diagram\b/i.test(line.text);
  const isText = (line: PositionedLine) => line.text.trim().length > 0 && !isDiagram(line);
  const centreOf = (box: { top: number; bottom: number }) => (box.top + box.bottom) / 2;

  // Rows inside a drawing are the drawing's, not a text line's.
  const diagramBoxes = lines
    .filter((line) => isDiagram(line) && line.box && line.box.bottom - line.box.top > 0.03)
    .map((line) => line.box!);
  const insideDiagram = (row: InkRow) =>
    diagramBoxes.some((box) => centreOf(row) > box.top - 0.01 && centreOf(row) < box.bottom + 0.01);
  const candidates = rows.filter((row) => !insideDiagram(row));

  const textIndices = lines.map((line, index) => (isText(line) ? index : -1)).filter((index) => index !== -1);
  const n = textIndices.length;
  const m = candidates.length;
  const result = lines.map((line) => ({ ...line }));

  // Drawings tighten to the ink they actually cover.
  for (const index of lines.keys()) {
    const line = lines[index]!;
    if (!isDiagram(line) || !line.box) continue;
    const covered = rows.filter((row) => centreOf(row) > line.box!.top - 0.01 && centreOf(row) < line.box!.bottom + 0.01);
    if (covered.length > 0) {
      result[index]!.box = {
        top: Math.min(...covered.map((row) => row.top)),
        bottom: Math.max(...covered.map((row) => row.bottom)),
        left: Math.min(...covered.map((row) => row.left)),
        right: Math.max(...covered.map((row) => row.right)),
      };
    }
  }

  if (n === 0 || m === 0) return result;

  const modelCentre = (i: number): number | null => {
    const line = lines[textIndices[i]!]!;
    return line.box && line.box.bottom - line.box.top <= MAX_TEXT_LINE_HEIGHT ? centreOf(line.box) : null;
  };

  /*
   * Two passes. The first aligns on order alone, with the raw coordinates as a
   * weak tie-break. Its pairs reveal how the model's coordinates drift down the
   * page — a straight line fits it well — so the second pass corrects the
   * coordinates by that fit and lets them weigh more, which is what separates
   * the right pairing from one shifted by a single row.
   */
  const first = alignSequences(n, m, (i, j) => {
    let cost = Math.abs(rank(i, n) - rank(j, m));
    const centre = modelCentre(i);
    if (centre !== null) {
      const gap = Math.abs(centre - centreOf(candidates[j]!));
      if (gap > MAX_COORDINATE_GAP) return null;
      cost += gap;
    }
    return cost;
  });

  const fit = fitDrift(first.map(([i, j]) => [modelCentre(i), centreOf(candidates[j]!)] as const));
  const pairs = fit
    ? alignSequences(n, m, (i, j) => {
        let cost = Math.abs(rank(i, n) - rank(j, m));
        const centre = modelCentre(i);
        if (centre !== null) {
          const gap = Math.abs(fit(centre) - centreOf(candidates[j]!));
          if (gap > MAX_COORDINATE_GAP) return null;
          cost += 2 * gap;
        }
        return cost;
      })
    : first;

  for (const [i, j] of pairs) {
    const row = candidates[j]!;
    result[textIndices[i]!]!.box = { top: row.top, bottom: row.bottom, left: row.left, right: row.right };
  }

  return result;
}

const rank = (i: number, total: number) => (total <= 1 ? 0 : i / (total - 1));

/**
 * Order-preserving alignment of two sequences (Needleman–Wunsch), returning the
 * matched index pairs. `pairCost` returns null for a pairing that is not
 * allowed at all.
 */
function alignSequences(n: number, m: number, pairCost: (i: number, j: number) => number | null): Array<[number, number]> {
  const INF = Number.POSITIVE_INFINITY;
  type Via = 'pair' | 'skipLine' | 'skipRow' | null;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(INF));
  const from: Via[][] = Array.from({ length: n + 1 }, () => new Array<Via>(m + 1).fill(null));
  dp[0]![0] = 0;
  for (let i = 0; i <= n; i += 1) {
    for (let j = 0; j <= m; j += 1) {
      if (i === 0 && j === 0) continue;
      let best = INF;
      let via: Via = null;
      if (i > 0 && j > 0) {
        const cost = pairCost(i - 1, j - 1);
        if (cost !== null && dp[i - 1]![j - 1]! + cost < best) {
          best = dp[i - 1]![j - 1]! + cost;
          via = 'pair';
        }
      }
      if (i > 0 && dp[i - 1]![j]! + SKIP_COST < best) {
        best = dp[i - 1]![j]! + SKIP_COST;
        via = 'skipLine';
      }
      if (j > 0 && dp[i]![j - 1]! + SKIP_COST < best) {
        best = dp[i]![j - 1]! + SKIP_COST;
        via = 'skipRow';
      }
      dp[i]![j] = best;
      from[i]![j] = via;
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const via = from[i]![j];
    if (via === 'pair') {
      pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (via === 'skipLine') {
      i -= 1;
    } else if (via === 'skipRow') {
      j -= 1;
    } else {
      break;
    }
  }
  return pairs.reverse();
}

/**
 * Least-squares line mapping the model's coordinate onto the row coordinate,
 * from the pairs of a first alignment. Null when there are too few pairs to
 * trust, or the fit is degenerate.
 */
function fitDrift(samples: ReadonlyArray<readonly [number | null, number]>): ((centre: number) => number) | null {
  const points = samples.filter((entry): entry is readonly [number, number] => entry[0] !== null);
  if (points.length < 4) return null;
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - meanX) ** 2;
    sxy += (x - meanX) * (y - meanY);
  }
  if (sxx < 1e-6) return null;
  const slope = sxy / sxx;
  if (slope < 0.5 || slope > 2) return null;
  const intercept = meanY - slope * meanX;
  return (centre: number) => intercept + slope * centre;
}

/**
 * A handwritten "Q" is often read as g, q, O, 0 or a stray glyph. The heading
 * is what ties an answer to its question, so a line that opens with such a
 * glyph and a question number is restored to "QN" when either the transcriber
 * says question N is on the page, or the line goes on like a heading does —
 * "(a)", ".", ":" — which no equation or sentence starts with. Nothing else on
 * the line is touched, and lines that already read as headings are left alone.
 */
export function normaliseHeadings(text: string, questionNumbers: number[]): string {
  const expected = new Set(questionNumbers);
  return text
    .split('\n')
    .map((line) => {
      const match = /^(\s*)(?:[gqoOØ0@&¤]|\(\s*[gq]\s*\))\s*\.?\s*(\d{1,3})(\s*(?:\(\s*[a-h]\s*\)|[.:]))?(?=\s|$|\()/u.exec(line);
      if (!match) return line;
      const number = Number(match[2]);
      const looksLikeHeading = match[3] !== undefined;
      if (!expected.has(number) && !looksLikeHeading) return line;
      return `${match[1] ?? ''}Q${match[2]}${match[3] ?? ''}${line.slice(match[0].length)}`;
    })
    .join('\n');
}

/* ------------------------------ degenerate pages ------------------------------ */

/** Sanity limits for one page of handwriting; beyond them the model has looped. */
const MAX_PAGE_CHARS = 7_000;
const MAX_DIAGRAM_MARKERS = 8;
const MAX_REPEATED_LINES = 4;

/**
 * Whether a transcript has come apart — a vision model occasionally repeats a
 * page's content or emits marker after marker with nothing behind them. The
 * same page read again usually comes back clean, so this decides when to ask.
 */
export function looksDegenerate(output: PageTranscriptOutput): boolean {
  const text = output.lines.map((line) => line.text).join('\n');
  if (text.length > MAX_PAGE_CHARS) return true;
  if ([...text.matchAll(DIAGRAM_MARKER)].length > MAX_DIAGRAM_MARKERS) return true;
  const seen = new Map<string, number>();
  let repeated = 0;
  for (const line of output.lines) {
    const key = line.text.trim();
    if (key.length < 25) continue;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 2) repeated += 1;
  }
  return repeated >= MAX_REPEATED_LINES;
}

/**
 * The best that can be made of a transcript that stayed degenerate after a
 * retry: repeated long lines are kept once, runs of empty markers collapse to a
 * single one, and the page is rated poor so the grader and teacher both know
 * the reading was unstable. Nothing legible is invented or removed beyond that.
 */
export function sanitiseTranscript(output: PageTranscriptOutput): PageTranscriptOutput {
  const described = new Set(output.diagrams.map((diagram) => diagram.marker));
  const seen = new Set<string>();
  const lines: PageTranscriptOutput['lines'] = [];
  let lastWasEmptyMarker = false;
  for (const line of output.lines) {
    const marker = MARKER_LINE.exec(line.text);
    if (marker && !described.has(Number(marker[1]))) {
      if (!lastWasEmptyMarker) lines.push({ ...line, text: '[diagram 0]' });
      lastWasEmptyMarker = true;
      continue;
    }
    lastWasEmptyMarker = false;
    const key = line.text.trim();
    if (key.length >= 25) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    lines.push(line);
  }
  return {
    ...output,
    lines,
    legibility: 'poor',
    unclear: [...output.unclear, 'the transcript of this page was unstable and has been cleaned; check it against the page'],
  };
}

/* -------------------------------- one page -------------------------------- */

interface OnePageInput {
  model: GradingModel;
  imageBase64: string;
  pageIndex: number;
  pageCount: number;
  previousTail: string | null;
  maxAttempts: number;
  retryBaseDelayMs: number;
  bytes: Buffer;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One page, with retries for transient failures, one re-render at lower
 * resolution if the provider refuses the image as too large, and one re-read
 * from a differently sized image if the transcript comes apart.
 */
async function transcribeOnePage(input: OnePageInput, shrunk = false): Promise<PageTranscriptOutput> {
  const { model } = input;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    try {
      const response = await model.transcribePage!({
        imageBase64: input.imageBase64,
        mimeType: 'image/jpeg',
        pageIndex: input.pageIndex,
        pageCount: input.pageCount,
        previousPageTail: input.previousTail,
      });
      const parsed = PageTranscriptOutputSchema.safeParse(response.data);
      if (parsed.success) {
        if (looksDegenerate(parsed.data)) {
          if (!shrunk) {
            const [again] = await renderPages(input.bytes, { pageIndices: [input.pageIndex], maxEdgePx: 1300, quality: 75 });
            if (again) {
              const retried = await transcribeOnePage({ ...input, imageBase64: again.jpeg.toString('base64') }, true);
              return looksDegenerate(retried) ? sanitiseTranscript(retried) : retried;
            }
          }
          return sanitiseTranscript(parsed.data);
        }
        return await describeMissingDiagrams(input, parsed.data);
      }
      lastError = new Error(
        `The transcriber's reply for page ${input.pageIndex + 1} did not match the expected shape: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`,
      );
    } catch (error) {
      if (error instanceof RequestTooLargeError && !shrunk) {
        const [smaller] = await renderPages(input.bytes, { pageIndices: [input.pageIndex], maxEdgePx: 1100, quality: 70 });
        if (smaller) return transcribeOnePage({ ...input, imageBase64: smaller.jpeg.toString('base64') }, true);
      }
      if (!isTransientModelError(error)) throw error;
      lastError = error;
    }
    if (attempt < input.maxAttempts) await sleep(input.retryBaseDelayMs * 2 ** (attempt - 1));
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * A transcriber that marks a drawing but does not describe it has lost the
 * drawing. One focused re-ask for the diagrams alone recovers it; if that also
 * yields nothing, the marker stays and says the drawing is undescribed.
 */
async function describeMissingDiagrams(input: OnePageInput, output: PageTranscriptOutput): Promise<PageTranscriptOutput> {
  if (undescribedDiagramMarkers(output).length === 0) return output;
  try {
    const response = await input.model.transcribePage!({
      imageBase64: input.imageBase64,
      mimeType: 'image/jpeg',
      pageIndex: input.pageIndex,
      pageCount: input.pageCount,
      previousPageTail: null,
      focus: 'diagrams',
    });
    const parsed = PageTranscriptOutputSchema.safeParse(response.data);
    if (!parsed.success || parsed.data.diagrams.length === 0) return output;
    const known = new Set(output.diagrams.map((diagram) => diagram.marker));
    return {
      ...output,
      diagrams: [...output.diagrams, ...parsed.data.diagrams.filter((diagram) => !known.has(diagram.marker))],
    };
  } catch {
    // Best effort: the transcript stands, with its markers marked undescribed.
    return output;
  }
}

function withTranscription(document: IngestedDocument, transcription: TranscriptionInfo): IngestedDocument {
  return { ...document, transcription };
}

function worstLegibility(values: Array<'good' | 'fair' | 'poor'>): 'good' | 'fair' | 'poor' | null {
  if (values.length === 0) return null;
  if (values.includes('poor')) return 'poor';
  if (values.includes('fair')) return 'fair';
  return 'good';
}

/** The name a provider reports for its vision model, when it exposes one. */
function visionModelName(model: GradingModel): string | null {
  const named = (model as { visionModelName?: string | null }).visionModelName;
  return typeof named === 'string' ? named : model.modelName;
}

/** Whether a transcribed document carries line positions, so its notes can sit beside the right lines. */
export function hasPositionedTranscript(document: IngestedDocument): boolean {
  const transcribed = document.pages.filter((page) => page.source === 'transcription');
  return transcribed.length > 0 && transcribed.some((page) => page.runs.length > 0);
}

/* ----------------------------- background queue ----------------------------- */

export interface TranscriptionQueueOptions {
  model: GradingModel;
  repository: Repository;
  maxAttempts: number;
  retryBaseDelayMs: number;
  log?: (message: string) => void;
}

/**
 * Transcribes scanned uploads once, and lets every caller wait for the same job.
 *
 * Reading six pages of handwriting takes a couple of minutes on a rate-limited
 * provider, so it starts the moment a scan is uploaded, while the teacher is
 * still reading the rubric, and is usually finished by the time the script is
 * marked. Grading and rubric extraction call `ensureReadable`, which returns at
 * once for a document with text, waits for a job already in flight, or runs the
 * transcription inline if nothing has started it. The result is written back to
 * the repository so the work is done once per document, not once per grading.
 */
export class TranscriptionQueue {
  private readonly jobs = new Map<string, Promise<IngestedDocument>>();

  constructor(private readonly options: TranscriptionQueueOptions) {}

  /** Whether this provider can read scanned pages at all. */
  get supported(): boolean {
    return typeof this.options.model.transcribePage === 'function';
  }

  /** Starts transcription without waiting for it. Failures are logged and left for `ensureReadable` to retry. */
  startInBackground(document: IngestedDocument, bytes: Buffer): void {
    if (!needsTranscription(document) || this.jobs.has(document.id)) return;
    this.run(document, bytes).catch((error) => {
      this.options.log?.(`[transcribe] ${document.filename}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** The document with readable text on every page, transcribing first if it has to. */
  async ensureReadable(document: IngestedDocument, bytes: Buffer): Promise<IngestedDocument> {
    if (!needsTranscription(document)) return document;
    const pending = this.jobs.get(document.id);
    if (pending) return pending;
    return this.run(document, bytes);
  }

  private run(document: IngestedDocument, bytes: Buffer): Promise<IngestedDocument> {
    const job = (async () => {
      const targets = pagesNeedingTranscription(document);
      this.options.log?.(
        `[transcribe] ${document.filename}: ${targets.length} page${targets.length === 1 ? '' : 's'} with no text layer; reading with ${this.options.model.providerName}.`,
      );

      let updated: IngestedDocument;
      try {
        updated = await transcribeDocument({
          document,
          bytes,
          model: this.options.model,
          maxAttempts: this.options.maxAttempts,
          retryBaseDelayMs: this.options.retryBaseDelayMs,
          onPage: (index, total) => this.options.log?.(`[transcribe] ${document.filename}: page ${index + 1} (${total} to read)`),
        });
      } catch (error) {
        updated = withTranscription(document, {
          status: 'failed',
          pages: targets,
          provider: this.options.model.providerName,
          model: visionModelName(this.options.model),
          at: new Date().toISOString(),
          legibility: null,
          unclear: [],
          error: error instanceof Error ? error.message : String(error),
        });
        await this.options.repository.updateDocument(updated);
        throw error;
      }

      await this.options.repository.updateDocument(updated);
      this.options.log?.(
        `[transcribe] ${document.filename}: done (${updated.transcription?.status}, legibility ${updated.transcription?.legibility ?? 'n/a'}, ${updated.transcription?.unclear.length ?? 0} unclear span(s), positions ${hasPositionedTranscript(updated) ? 'known' : 'unknown'}).`,
      );
      return updated;
    })();

    this.jobs.set(document.id, job);
    job.finally(() => this.jobs.delete(document.id)).catch(() => undefined);
    return job;
  }
}
