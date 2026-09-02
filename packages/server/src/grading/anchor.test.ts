import { beforeAll, describe, expect, it } from 'vitest';
import type { PageText } from '@gradesense/shared';
import { loadAnswerFixture } from '../test-support.js';
import { anchorQuote, anchorRegion, marginNoteRect } from './anchor.js';

/**
 * Anchoring against the real answer papers.
 *
 * These run on the actual PDF text layer rather than synthetic strings, because
 * the interesting problems — a line emitted as one positioned run, a quote that
 * wraps across two lines, a coordinate system with its origin in the wrong
 * corner — only exist once a real PDF has been parsed.
 */

let pages: PageText[];
let scannedPages: PageText[];

beforeAll(async () => {
  pages = (await loadAnswerFixture('student-answer')).document.pages;
  scannedPages = (await loadAnswerFixture('ocr-errors')).document.pages;
});

function expectValidRect(rect: { page: number; x: number; y: number; width: number; height: number }) {
  expect(rect.page).toBeGreaterThanOrEqual(0);
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(1.0001);
  expect(rect.y + rect.height).toBeLessThanOrEqual(1.0001);
}

describe('anchoring a quote to the page', () => {
  it('places a verbatim quote exactly', () => {
    const anchor = anchorQuote('The voltmeter is also connected in series with the bulb', pages);

    expect(anchor.status).toBe('exact');
    expect(anchor.similarity).toBe(1);
    expect(anchor.rects.length).toBeGreaterThan(0);
    anchor.rects.forEach(expectValidRect);
  });

  it('produces one box per line for a quote that wraps', () => {
    // This sentence runs across a line break in the rendered paper.
    const anchor = anchorQuote(
      'The ameter is connected in series because it has to measure the current which is passing through the circuit',
      pages,
    );

    expect(anchor.status).toBe('exact');
    expect(anchor.rects.length).toBeGreaterThan(1);

    // Distinct lines, so distinct vertical positions.
    const ys = anchor.rects.map((rect) => rect.y);
    expect(new Set(ys).size).toBe(ys.length);
    anchor.rects.forEach(expectValidRect);
  });

  it('boxes a phrase inside a line rather than the whole line', () => {
    const phrase = anchorQuote('Some people say that technology is helpful', pages);
    const wholeLine = anchorQuote(
      'So in conclusion I believe that technology is making students dependent on ready made answers instead of making',
      pages,
    );

    expect(phrase.status).toBe('exact');
    expect(wholeLine.status).toBe('exact');

    // Sub-line interpolation is what makes this narrower than a full line.
    const phraseWidth = phrase.rects[0]!.width;
    const lineWidth = wholeLine.rects[0]!.width;
    expect(phraseWidth).toBeLessThan(lineWidth);
  });

  it('finds a quote on the second page', () => {
    const anchor = anchorQuote(
      'When the price is below the equilibrium price there is a surplus in the market',
      pages,
    );

    expect(anchor.status).toBe('exact');
    expect(anchor.rects[0]!.page).toBe(1);
  });

  it('still anchors a quote through OCR damage', () => {
    // Quoted as the word should be spelled; the paper has it mangled.
    const anchor = anchorQuote(
      'The battery, switch, resistor, bulb and ammeter are connected in series',
      scannedPages,
    );

    expect(anchor.status).toBe('fuzzy');
    expect(anchor.similarity).toBeGreaterThan(0.8);
    expect(anchor.similarity).toBeLessThan(1);
    anchor.rects.forEach(expectValidRect);
  });

  it('reports unresolved rather than guessing at a quote that is absent', () => {
    const anchor = anchorQuote(
      'The student wrote a beautifully reasoned paragraph about quantum tunnelling here.',
      pages,
    );

    expect(anchor.status).toBe('unresolved');
    expect(anchor.rects).toHaveLength(0);
  });

  it('refuses a quote too short to place unambiguously', () => {
    expect(anchorQuote('the', pages).status).toBe('unresolved');
    expect(anchorQuote('', pages).status).toBe('unresolved');
    expect(anchorQuote(null, pages).status).toBe('unresolved');
  });

  it('prefers the hinted page but does not insist on it', () => {
    // The quote is on page 1; the hint points at page 0.
    const anchor = anchorQuote(
      'When the price is below the equilibrium price there is a surplus in the market',
      pages,
      0,
    );

    expect(anchor.status).toBe('exact');
    expect(anchor.rects[0]!.page).toBe(1);
  });
});

describe('anchoring a diagram region', () => {
  /*
   * A model's box is treated as a pointer, not as coordinates. What gets drawn
   * is the drawing measured from its own labels, so an approximate box and a
   * badly wrong one that still points at the right drawing produce the same,
   * correct rectangle.
   */
  it('snaps an approximate box onto the whole drawing it points at', () => {
    const anchor = anchorRegion({ page: 0, x: 0.15, y: 0.36, width: 0.7, height: 0.19 }, pages);

    expect(anchor.status).toBe('region');
    expect(anchor.rects).toHaveLength(1);

    const rect = anchor.rects[0]!;
    expectValidRect(rect);
    expect(rect.page).toBe(0);
    // The model's box stopped at x 0.85 and cut the ammeter off; the measured
    // one reaches it. It also reaches down past the voltmeter, which the
    // model's box ended above.
    expect(rect.x + rect.width).toBeGreaterThan(0.96);
    expect(rect.y + rect.height).toBeGreaterThan(0.55);
    // …and it stops short of the next answer rather than running over it.
    expect(rect.y + rect.height).toBeLessThan(0.62);
  });

  it('turns a sliver beside one axis number into the whole graph', () => {
    // A real box returned for the economics graph: tall, 5% of the page wide,
    // standing beside the "10" on the axis and covering none of the drawing.
    const anchor = anchorRegion({ page: 1, x: 0.2, y: 0.3, width: 0.05, height: 0.32 }, pages);

    expect(anchor.status).toBe('region');
    const rect = anchor.rects[0]!;
    expect(rect.page).toBe(1);
    expect(rect.width).toBeGreaterThan(0.4);
    expect(rect.y).toBeLessThan(0.32);
    expect(rect.y + rect.height).toBeGreaterThan(0.52);
  });

  it('recovers a box that missed the drawing but sits just below it', () => {
    const anchor = anchorRegion({ page: 1, x: 0.08, y: 0.58, width: 0.8, height: 0.1 }, pages);

    expect(anchor.status).toBe('region');
    expect(anchor.rects[0]!.y).toBeLessThan(0.32);
  });

  it('refuses to draw a box that points at no drawing at all', () => {
    // Blank paper at the foot of the page. Nothing is there to frame, so this
    // becomes a margin note rather than a rectangle across empty space.
    const anchor = anchorRegion({ page: 1, x: 0.05, y: 0.9, width: 0.2, height: 0.05 }, pages);

    expect(anchor.status).toBe('unresolved');
    expect(anchor.rects).toEqual([]);
  });

  it('keeps a region on the page the drawing is actually on', () => {
    // A box claiming page 0 coordinates for the economics graph still resolves
    // to the circuit on page 0 — the page number is the model's claim, and the
    // measurement is ours.
    const anchor = anchorRegion({ page: 1, x: 0.3, y: 0.4, width: 0.2, height: 0.1 }, pages);

    expect(anchor.rects[0]!.page).toBe(1);
  });

  it('clamps a page index beyond the document', () => {
    const anchor = anchorRegion({ page: 99, x: 0.1, y: 0.3, width: 0.5, height: 0.2 }, pages);

    expect(anchor.rects[0]!.page).toBe(pages.length - 1);
  });

  it('rejects a missing region', () => {
    expect(anchorRegion(null, pages).status).toBe('unresolved');
  });

  it('survives nonsense coordinates without drawing anything', () => {
    const anchor = anchorRegion(
      { page: -5, x: Number.NaN, y: -1, width: Number.POSITIVE_INFINITY, height: 0 },
      pages,
    );

    expect(anchor.status).toBe('unresolved');
    expect(anchor.rects).toEqual([]);
  });

  it('finds nothing to snap to on a page with no drawing', async () => {
    const blank = (await loadAnswerFixture('blank')).document.pages;
    const anchor = anchorRegion({ page: 0, x: 0.2, y: 0.4, width: 0.5, height: 0.2 }, blank);

    expect(anchor.status).toBe('unresolved');
  });
});

describe('margin notes', () => {
  it('sit inside the page and do not overlap each other', () => {
    const first = marginNoteRect(0, 0);
    const second = marginNoteRect(0, 1);

    expectValidRect(first);
    expectValidRect(second);
    expect(second.y).toBeGreaterThan(first.y + first.height * 0.5);
  });

  it('stay on the page however many are needed', () => {
    for (let slot = 0; slot < 30; slot += 1) {
      expectValidRect(marginNoteRect(1, slot));
    }
  });
});
