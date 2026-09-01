import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { PageText, TextRun } from '@gradesense/shared';
import { PdfUnreadableError } from '../errors.js';

/**
 * PDF text extraction with coordinates.
 *
 * The whole annotation feature rests on this file. For every run of text in the
 * document we record both its rectangle on the page and its character range in
 * that page's plain text. Later, when the model hands back a quote, we find the
 * quote's character range and read the rectangles straight back out — which is
 * why annotations land on the right words instead of being guessed at.
 *
 * pdf.js is used through its `legacy` build because that is the one that runs
 * under Node without a DOM. It is loaded lazily so importing this module never
 * pays the cost, and typed through a narrow local interface rather than the
 * package's own types, which are not exported cleanly for ESM consumers.
 */

interface PdfTextItem {
  str: string;
  /** [scaleX, skewY, skewX, scaleY, translateX, translateY] */
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

interface PdfTextContent {
  items: Array<PdfTextItem | { type: string }>;
}

interface PdfPageProxy {
  getViewport(params: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<PdfTextContent>;
  cleanup(): void;
}

interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  destroy(): Promise<void>;
}

interface PdfJsModule {
  getDocument(params: Record<string, unknown>): { promise: Promise<PdfDocumentProxy> };
}

const require = createRequire(import.meta.url);

let pdfjsPromise: Promise<PdfJsModule> | null = null;

async function loadPdfjs(): Promise<PdfJsModule> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs') as Promise<PdfJsModule>;
  return pdfjsPromise;
}

/**
 * pdf.js needs the standard-font metrics on disk to lay out documents that use
 * the base-14 fonts — which the generated answer papers do. Resolving through
 * `require.resolve` keeps this working regardless of where npm hoisted the
 * package to.
 */
function standardFontDataUrl(): string | undefined {
  try {
    const entry = require.resolve('pdfjs-dist/package.json');
    return `${path.join(path.dirname(entry), 'standard_fonts')}${path.sep}`;
  } catch {
    return undefined;
  }
}

/**
 * A text item's rectangle, converted from PDF space (origin bottom-left, y is
 * the text baseline) into normalised top-left space (0..1 of the page box).
 *
 * The vertical fudge factors turn a baseline into a box that visually encloses
 * the glyphs: roughly 80% of the font height sits above the baseline and 20%
 * below. Underlines and highlight boxes both look wrong without this.
 */
const ASCENT_RATIO = 0.8;
const BOX_HEIGHT_RATIO = 1.05;

function itemRect(
  item: PdfTextItem,
  pageIndex: number,
  pageWidth: number,
  pageHeight: number,
): { page: number; x: number; y: number; width: number; height: number } {
  const transform = item.transform;
  const x = transform[4] ?? 0;
  const baselineY = transform[5] ?? 0;
  // |scaleY| is the effective font size; item.height is unreliable for some
  // producers, so prefer the transform and keep height as a fallback.
  const fontHeight = Math.abs(transform[3] ?? 0) || item.height || 10;

  const topFromTop = pageHeight - baselineY - fontHeight * ASCENT_RATIO;
  const boxHeight = fontHeight * BOX_HEIGHT_RATIO;

  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  const nx = clamp01(x / pageWidth);
  const ny = clamp01(topFromTop / pageHeight);

  return {
    page: pageIndex,
    x: nx,
    y: ny,
    // Keep the box inside the page even when a run starts near the right edge.
    width: clamp01(Math.max(item.width, 1) / pageWidth),
    height: clamp01(boxHeight / pageHeight),
  };
}

function isTextItem(item: PdfTextItem | { type: string }): item is PdfTextItem {
  return typeof (item as PdfTextItem).str === 'string';
}

/**
 * Decides whether two consecutive text items need a separator between them.
 *
 * pdf.js emits one item per positioning change, so words are frequently split
 * without any whitespace of their own. Without this, "in series" would come out
 * as "inseries" and every quote match against it would fail.
 */
function separatorBetween(previous: PdfTextItem, next: PdfTextItem): string {
  if (previous.hasEOL) return '\n';

  const prevEndX = (previous.transform[4] ?? 0) + previous.width;
  const nextX = next.transform[4] ?? 0;
  const prevY = previous.transform[5] ?? 0;
  const nextY = next.transform[5] ?? 0;

  // A baseline shift of more than a couple of points means a new line.
  if (Math.abs(prevY - nextY) > 2.5) return '\n';

  // Whitespace already present in the runs themselves is enough.
  if (/\s$/.test(previous.str) || /^\s/.test(next.str)) return '';

  const gap = nextX - prevEndX;
  const fontHeight = Math.abs(previous.transform[3] ?? 0) || 10;
  // A gap wider than a fifth of the font size reads as a word break; anything
  // tighter is kerning within a word.
  return gap > fontHeight * 0.2 ? ' ' : '';
}

export interface ExtractedPdf {
  pageCount: number;
  pages: PageText[];
  fullText: string;
  sha256: string;
}

export async function extractPdf(bytes: Buffer): Promise<ExtractedPdf> {
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

  let pdfjs: PdfJsModule;
  try {
    pdfjs = await loadPdfjs();
  } catch (error) {
    throw new PdfUnreadableError('PDF engine failed to load.', error);
  }

  let document: PdfDocumentProxy;
  try {
    document = await pdfjs.getDocument({
      // pdf.js transfers ownership of the buffer it is given, so hand it a copy —
      // the caller still needs these bytes to store the original file.
      data: new Uint8Array(bytes),
      standardFontDataUrl: standardFontDataUrl(),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: false,
      // pdf.js is chatty about harmless font quirks; keep the server log usable.
      verbosity: 0,
    }).promise;
  } catch (error) {
    throw new PdfUnreadableError(
      'Could not open this file as a PDF. It may be corrupt, encrypted, or not a PDF at all.',
      error,
    );
  }

  try {
    const pages: PageText[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items.filter(isTextItem).filter((item) => item.str.length > 0);

      let text = '';
      const runs: TextRun[] = [];

      items.forEach((item, index) => {
        const previous = index > 0 ? items[index - 1] : undefined;
        if (previous) {
          text += separatorBetween(previous, item);
        }

        const start = text.length;
        text += item.str;
        runs.push({
          text: item.str,
          start,
          end: text.length,
          rect: itemRect(item, pageNumber - 1, viewport.width, viewport.height),
        });
      });

      pages.push({
        index: pageNumber - 1,
        width: viewport.width,
        height: viewport.height,
        text,
        runs,
      });

      page.cleanup();
    }

    return {
      pageCount: document.numPages,
      pages,
      fullText: pages.map((page) => page.text).join('\n\f\n'),
      sha256,
    };
  } catch (error) {
    throw new PdfUnreadableError('Failed while reading the pages of this PDF.', error);
  } finally {
    await document.destroy().catch(() => undefined);
  }
}

/** Cheap sniff so a mislabelled upload fails fast with a clear message. */
export function looksLikePdf(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes.subarray(0, 5).toString('latin1') === '%PDF-';
}
