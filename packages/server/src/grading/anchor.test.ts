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
  it('accepts a sensible region and marks it approximate', () => {
    const anchor = anchorRegion({ page: 1, x: 0.2, y: 0.3, width: 0.5, height: 0.25 }, 2);

    expect(anchor.status).toBe('region');
    expect(anchor.rects).toHaveLength(1);
    expectValidRect(anchor.rects[0]!);
  });

  it('clamps a region that runs off the page', () => {
    const anchor = anchorRegion({ page: 0, x: 0.9, y: 0.9, width: 0.8, height: 0.8 }, 2);

    expect(anchor.status).toBe('region');
    expectValidRect(anchor.rects[0]!);
  });

  it('clamps a page index beyond the document', () => {
    const anchor = anchorRegion({ page: 99, x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, 2);

    expect(anchor.rects[0]!.page).toBe(1);
  });

  it('rejects a missing region', () => {
    expect(anchorRegion(null, 2).status).toBe('unresolved');
  });

  it('survives nonsense coordinates', () => {
    const anchor = anchorRegion(
      { page: -5, x: Number.NaN, y: -1, width: Number.POSITIVE_INFINITY, height: 0 },
      2,
    );

    expect(anchor.rects).toHaveLength(1);
    expectValidRect(anchor.rects[0]!);
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
