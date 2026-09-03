import path from 'node:path';
import { createRequire } from 'node:module';
import { PdfUnreadableError } from '../errors.js';

/**
 * Turning PDF pages into images a vision model can look at.
 *
 * A scanned answer sheet has no text layer: each page is one photograph, and
 * `extractPdf` sees nothing on it. The only way to read such a page is to look
 * at it, so it is rasterised here and handed to a model that can. Typed PDFs
 * never come through this path — they already have their text.
 *
 * Rendering goes through pdf.js, the same engine that extracts text, drawing
 * onto an `@napi-rs/canvas` surface (prebuilt, no native toolchain). Pages are
 * scaled so the long edge is about 1,600 pixels: enough for handwriting and
 * subscripts to stay legible, small enough that a page costs a vision model
 * about two thousand tokens rather than ten. JPEG rather than PNG for the same
 * reason — a photograph of paper compresses ten to one with no legible loss.
 */

export interface RenderedPage {
  /** Zero-based page index. */
  index: number;
  width: number;
  height: number;
  jpeg: Buffer;
  /**
   * Where the writing actually is: one band per row of ink, in page fractions,
   * top to bottom. Ruled lines and the margin rule are excluded. Used to snap a
   * vision model's rough line positions onto the real lines.
   */
  inkRows: InkRow[];
}

/** A horizontal band of ink on the page, in fractions of the page (0,0 top-left). */
export interface InkRow {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface RenderOptions {
  /** Pages to render; all of them when omitted. */
  pageIndices?: number[];
  /** Longest edge of the output, in pixels. */
  maxEdgePx?: number;
  /** JPEG quality, 1–100. */
  quality?: number;
}

const DEFAULT_MAX_EDGE = 1600;
const DEFAULT_QUALITY = 80;

interface Canvas2D {
  getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray };
}

interface CanvasModule {
  createCanvas(width: number, height: number): {
    width: number;
    height: number;
    getContext(kind: '2d'): Canvas2D;
    toBuffer(mime: 'image/jpeg', quality?: number): Buffer;
  };
}

interface PdfPage {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: { canvasContext: unknown; viewport: unknown }): { promise: Promise<void> };
  cleanup(): void;
}

interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}

interface PdfJs {
  getDocument(params: Record<string, unknown>): { promise: Promise<PdfDocument> };
}

const require = createRequire(import.meta.url);

let canvasPromise: Promise<CanvasModule | null> | null = null;
let pdfjsPromise: Promise<PdfJs> | null = null;

/** Loaded lazily and once; absent on a platform without a prebuilt binary. */
async function loadCanvas(): Promise<CanvasModule | null> {
  canvasPromise ??= import('@napi-rs/canvas').then(
    (module) => module as unknown as CanvasModule,
    () => null,
  );
  return canvasPromise;
}

async function loadPdfjs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs') as Promise<PdfJs>;
  return pdfjsPromise;
}

function standardFontDataUrl(): string | undefined {
  try {
    const entry = require.resolve('pdfjs-dist/package.json');
    return `${path.join(path.dirname(entry), 'standard_fonts')}${path.sep}`;
  } catch {
    return undefined;
  }
}

/** Whether this machine can rasterise pages at all. */
export async function canRenderPages(): Promise<boolean> {
  return (await loadCanvas()) !== null;
}

export async function renderPages(bytes: Buffer, options: RenderOptions = {}): Promise<RenderedPage[]> {
  const canvas = await loadCanvas();
  if (!canvas) {
    throw new PdfUnreadableError(
      'This answer sheet is a scan with no text layer, and the page renderer (@napi-rs/canvas) is not available on this machine, so its pages cannot be read.',
    );
  }

  const maxEdge = options.maxEdgePx ?? DEFAULT_MAX_EDGE;
  const quality = options.quality ?? DEFAULT_QUALITY;

  const pdfjs = await loadPdfjs();
  let document: PdfDocument;
  try {
    document = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      standardFontDataUrl: standardFontDataUrl(),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;
  } catch (error) {
    throw new PdfUnreadableError('Could not open this file as a PDF to render its pages.', error);
  }

  try {
    const indices = options.pageIndices ?? Array.from({ length: document.numPages }, (_, i) => i);
    const rendered: RenderedPage[] = [];

    for (const index of indices) {
      if (index < 0 || index >= document.numPages) continue;
      const page = await document.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, maxEdge / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });

      const surface = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = surface.getContext('2d');
      await page.render({ canvasContext: context, viewport }).promise;
      page.cleanup();

      const pixels = context.getImageData(0, 0, surface.width, surface.height).data;
      rendered.push({
        index,
        width: surface.width,
        height: surface.height,
        jpeg: surface.toBuffer('image/jpeg', quality),
        inkRows: detectInkRows(pixels, surface.width, surface.height),
      });
    }

    return rendered;
  } catch (error) {
    if (error instanceof PdfUnreadableError) throw error;
    throw new PdfUnreadableError('Failed while rendering the pages of this PDF.', error);
  } finally {
    await document.destroy().catch(() => undefined);
  }
}

/* -------------------------------- ink rows -------------------------------- */

/** Pixels darker than this (0–255 grey) count as ink. Paper is far lighter; ruled lines usually are too. */
const INK_THRESHOLD = 110;
/** A pixel row holding one unbroken stroke longer than this share of the width is a ruled line, not writing. */
const MAX_RULE_RUN = 0.3;
/** A pixel column with ink down more than this share of the page is a margin rule, not writing. */
const MAX_COLUMN_COVERAGE = 0.35;
/** A row of pixels needs at least this share of its width inked to belong to a band of writing. */
const MIN_ROW_INK_FRACTION = 0.004;
/** Bands shorter than this (fraction of page height) are specks or rule remnants, not a line of handwriting. */
const MIN_BAND_HEIGHT = 0.008;
/** Gaps between bands smaller than this are joined: a dotted i or a broken stroke splits a line otherwise. */
const MAX_JOIN_GAP = 0.003;
/** A band taller than this multiple of the typical band is two lines whose descenders touch; it is split at its ink valley. */
const TALL_BAND_FACTOR = 1.35;
/** A split needs a real gap: the thinnest row of the band must hold less than this share of the band's average ink. */
const VALLEY_RATIO = 0.45;
/** Left/right extents ignore the outermost specks: these percentiles of the inked pixels. */
const EXTENT_PERCENTILE = 0.01;

interface Band {
  top: number;
  bottom: number;
}

/**
 * Finds the rows of handwriting on a page from its pixels.
 *
 * The idea is the oldest one in document analysis: ink is dark, paper is not,
 * and a line of writing is a horizontal band with ink in it. Three things on a
 * school answer sheet defeat the naive version and are handled explicitly.
 * Ruled lines are rows with ink right across the width — excluded by their
 * density before anything is counted. The margin rule is a column with ink
 * down most of the page — excluded the same way. And two lines of handwriting
 * touch where a descender meets the ascenders below — a band that is much
 * taller than its neighbours is split at the thinnest row of ink inside it.
 * What remains are the rows a teacher would point at, with their true extents.
 */
export function detectInkRows(pixels: Uint8ClampedArray, width: number, height: number): InkRow[] {
  if (width === 0 || height === 0) return [];

  const ink = new Uint8Array(width * height);
  const columnInk = new Uint32Array(width);
  const longestRun = new Uint32Array(height);
  for (let y = 0; y < height; y += 1) {
    let run = 0;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const grey = (pixels[i]! * 299 + pixels[i + 1]! * 587 + pixels[i + 2]! * 114) / 1000;
      if (grey < INK_THRESHOLD) {
        ink[y * width + x] = 1;
        columnInk[x] = columnInk[x]! + 1;
        run += 1;
        if (run > longestRun[y]!) longestRun[y] = run;
      } else {
        run = 0;
      }
    }
  }

  // Rules: a row with one long unbroken stroke (handwriting is fragmented),
  // a column inked down most of the page.
  const ruledRow = new Uint8Array(height);
  for (let y = 0; y < height; y += 1) if (longestRun[y]! / width > MAX_RULE_RUN) ruledRow[y] = 1;
  const maskedColumn = new Uint8Array(width);
  for (let x = 0; x < width; x += 1) if (columnInk[x]! / height > MAX_COLUMN_COVERAGE) maskedColumn[x] = 1;

  // Ink per row, with the rules taken out.
  const rowInk = new Uint32Array(height);
  for (let y = 0; y < height; y += 1) {
    if (ruledRow[y]) continue;
    for (let x = 0; x < width; x += 1) if (!maskedColumn[x] && ink[y * width + x]) rowInk[y] = rowInk[y]! + 1;
  }

  // Bands of consecutive inked rows, joined across tiny gaps.
  const minInk = Math.max(3, Math.round(width * MIN_ROW_INK_FRACTION));
  const bands: Band[] = [];
  let start = -1;
  for (let y = 0; y <= height; y += 1) {
    const inked = y < height && rowInk[y]! >= minInk;
    if (inked && start === -1) start = y;
    if (!inked && start !== -1) {
      bands.push({ top: start, bottom: y });
      start = -1;
    }
  }
  const joinGap = Math.max(1, Math.round(height * MAX_JOIN_GAP));
  const joined: Band[] = [];
  for (const band of bands) {
    const previous = joined[joined.length - 1];
    if (previous && band.top - previous.bottom <= joinGap) previous.bottom = band.bottom;
    else joined.push({ ...band });
  }

  const minHeight = Math.max(2, Math.round(height * MIN_BAND_HEIGHT));
  const kept = joined.filter((band) => band.bottom - band.top >= minHeight);
  if (kept.length === 0) return [];

  // Two lines whose descenders touch make one tall band: split it at the valley.
  const heights = kept.map((band) => band.bottom - band.top).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)]!;
  const split: Band[] = [];
  const splitTall = (band: Band, depth: number): void => {
    const size = band.bottom - band.top;
    if (depth > 3 || size < typical * TALL_BAND_FACTOR || size < minHeight * 2) {
      split.push(band);
      return;
    }
    // The thinnest row of ink in the middle half of the band is where the lines
    // meet — but only if it really is thin. A tall single line (capitals over
    // descenders) has no such valley and stays whole.
    let valley = -1;
    let valleyInk = Number.POSITIVE_INFINITY;
    let total = 0;
    for (let y = band.top; y < band.bottom; y += 1) total += rowInk[y]!;
    const mean = total / size;
    for (let y = band.top + Math.floor(size / 4); y < band.bottom - Math.floor(size / 4); y += 1) {
      if (rowInk[y]! < valleyInk) {
        valleyInk = rowInk[y]!;
        valley = y;
      }
    }
    if (valley === -1 || valleyInk > mean * VALLEY_RATIO) {
      split.push(band);
      return;
    }
    splitTall({ top: band.top, bottom: valley }, depth + 1);
    splitTall({ top: valley + 1, bottom: band.bottom }, depth + 1);
  };
  for (const band of kept) splitTall(band, 0);

  return split
    .filter((band) => band.bottom - band.top >= minHeight)
    .map((band) => {
      // Horizontal extents from the inked pixels of the band, ignoring rules and outliers.
      const xs: number[] = [];
      for (let y = band.top; y < band.bottom; y += 1) {
        if (ruledRow[y]) continue;
        for (let x = 0; x < width; x += 1) if (!maskedColumn[x] && ink[y * width + x]) xs.push(x);
      }
      xs.sort((a, b) => a - b);
      const lo = xs[Math.floor(xs.length * EXTENT_PERCENTILE)] ?? 0;
      const hi = xs[Math.min(xs.length - 1, Math.ceil(xs.length * (1 - EXTENT_PERCENTILE)))] ?? lo;
      return {
        top: band.top / height,
        bottom: band.bottom / height,
        left: lo / width,
        right: Math.max(lo + 1, hi + 1) / width,
      };
    });
}
