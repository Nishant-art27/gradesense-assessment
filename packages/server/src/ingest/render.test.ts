import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { canRenderPages, renderPages } from './render.js';

/**
 * Rendering is what makes a scanned sheet readable at all, so it is tested
 * against a PDF built here rather than a fixture: two pages of different sizes,
 * one with text and a drawn shape, one blank. The assertions are about the
 * contract — every requested page, a real JPEG, bounded size — not about pixels.
 */
async function makePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([595, 842]);
  first.drawText('Q31 (a) The dipole has charges +q and -q', { x: 50, y: 780, size: 14, font });
  first.drawRectangle({ x: 100, y: 400, width: 200, height: 120, borderColor: rgb(0, 0, 0), borderWidth: 2 });
  pdf.addPage([842, 595]);
  return Buffer.from(await pdf.save());
}

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describe('renderPages', () => {
  it('renders every page as a JPEG no larger than the requested edge', async () => {
    if (!(await canRenderPages())) return;
    const pages = await renderPages(await makePdf(), { maxEdgePx: 800 });

    expect(pages.map((page) => page.index)).toEqual([0, 1]);
    for (const page of pages) {
      expect(page.jpeg.subarray(0, 3).equals(JPEG_MAGIC)).toBe(true);
      expect(Math.max(page.width, page.height)).toBeLessThanOrEqual(800);
      expect(page.jpeg.length).toBeGreaterThan(1_000);
    }
    // Portrait stays portrait, landscape stays landscape.
    expect(pages[0]!.height).toBeGreaterThan(pages[0]!.width);
    expect(pages[1]!.width).toBeGreaterThan(pages[1]!.height);
  });

  it('renders only the pages asked for, ignoring indices that do not exist', async () => {
    if (!(await canRenderPages())) return;
    const pages = await renderPages(await makePdf(), { pageIndices: [1, 7] });
    expect(pages.map((page) => page.index)).toEqual([1]);
  });

  it('refuses something that is not a PDF with a readable error', async () => {
    if (!(await canRenderPages())) return;
    await expect(renderPages(Buffer.from('not a pdf'))).rejects.toThrow(/Could not open this file as a PDF/);
  });
});

describe('detectInkRows', () => {
  it('finds the rows of writing and ignores ruled lines and the margin rule', async () => {
    if (!(await canRenderPages())) return;
    const { createCanvas } = await import('@napi-rs/canvas');
    const { detectInkRows } = await import('./render.js');
    const width = 600;
    const height = 800;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    // Faint ruled lines every 40px, a dark margin rule, and three "lines of writing".
    ctx.fillStyle = '#c8c8c8';
    for (let y = 40; y < height; y += 40) ctx.fillRect(0, y, width, 2);
    ctx.fillStyle = '#202020';
    ctx.fillRect(60, 0, 3, height);
    ctx.fillStyle = '#101040';
    ctx.font = '22px sans-serif';
    ctx.fillText('The dipole has charges +q and -q', 90, 130);
    ctx.fillText('E = 2qa / r^3', 90, 330);
    ctx.fillText('Torque = 0', 250, 530);
    const pixels = ctx.getImageData(0, 0, width, height).data;

    const rows = detectInkRows(pixels, width, height);

    expect(rows).toHaveLength(3);
    // Text baselines at 130/330/530 with ~22px glyphs → bands around 14–16% / 39–41% / 64–66%.
    expect(rows[0]!.top).toBeGreaterThan(0.13);
    expect(rows[0]!.bottom).toBeLessThan(0.17);
    expect(rows[1]!.top).toBeGreaterThan(0.38);
    expect(rows[2]!.top).toBeGreaterThan(0.63);
    // Extents start at the writing, not at the margin rule, and the short line is narrower.
    expect(rows[0]!.left).toBeGreaterThan(0.12);
    expect(rows[2]!.left).toBeGreaterThan(0.4);
    expect(rows[2]!.right - rows[2]!.left).toBeLessThan(rows[0]!.right - rows[0]!.left);
  });
});


describe('detectInkRows on touching lines', () => {
  /** A synthetic page: dark rectangles for strokes on white, as RGBA pixels. */
  function page(width: number, height: number, strokes: Array<[x: number, y: number, w: number, h: number, grey?: number]>): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    for (const [x0, y0, w, h, grey = 20] of strokes) {
      for (let y = y0; y < y0 + h; y += 1) {
        for (let x = x0; x < x0 + w; x += 1) {
          const i = (y * width + x) * 4;
          pixels[i] = pixels[i + 1] = pixels[i + 2] = grey;
        }
      }
    }
    return pixels;
  }

  it('splits two lines joined by a descender, and ignores dark ruled lines', async () => {
    const { detectInkRows } = await import('./render.js');
    const width = 400;
    const height = 400;
    // "Words": short dark segments with gaps, the way letters are; rules are unbroken.
    const words = (x: number, y: number, count: number, h = 30): Array<[number, number, number, number]> =>
      Array.from({ length: count }, (_, i) => [x + i * 40, y, 28, h]);
    const pixels = page(width, height, [
      [0, 99, 400, 2, 90], // a dark ruled line right across the page
      [0, 199, 400, 2, 90],
      ...words(40, 60, 5), // line one, x 40–228
      [120, 90, 6, 14], // a descender reaching down into...
      ...words(40, 104, 6), // ...line two, x 40–268
      ...words(60, 250, 3), // line three, alone, x 60–168
    ]);

    const rows = detectInkRows(pixels, width, height);

    expect(rows).toHaveLength(3);
    expect(rows[0]!.top * height).toBeCloseTo(60, -1);
    expect(rows[1]!.top * height).toBeGreaterThan(95);
    expect(rows[1]!.bottom * height).toBeCloseTo(134, -1);
    expect(rows[2]!.top * height).toBeCloseTo(250, -1);
    // Extents come from the writing, not from the ruled lines.
    expect(rows[0]!.left * width).toBeCloseTo(40, -1);
    expect(rows[0]!.right * width).toBeCloseTo(228, -1);
    expect(rows[2]!.left * width).toBeCloseTo(60, -1);
    expect(rows[2]!.right * width).toBeCloseTo(168, -1);
  });
});
