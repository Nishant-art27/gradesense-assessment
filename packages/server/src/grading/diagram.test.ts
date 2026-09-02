import { beforeAll, describe, expect, it } from 'vitest';
import type { PageText } from '@gradesense/shared';
import { loadAnswerFixture } from '../test-support.js';
import { findAllDiagramRegions, findDiagramByCaption, findDiagramRegions } from './diagram.js';

/**
 * Measuring the drawings on a page.
 *
 * These run against the real answer papers, because every hard case here is a
 * property of a genuine PDF text layer: a label that happens to sit on the left
 * margin, a page header whose three fields look like labels side by side, a page
 * holding a drawing and nothing else.
 *
 * The assertions are about extent rather than exact numbers. What matters is
 * that a box contains the drawing it names and stops before the next answer —
 * a box that is a few thousandths out is fine, one that clips the ammeter or
 * runs over the essay below is not.
 */

let answer: PageText[];
let correct: PageText[];
let sparse: PageText[];
let blank: PageText[];

const pagesOf = async (slug: Parameters<typeof loadAnswerFixture>[0]) =>
  (await loadAnswerFixture(slug)).document.pages;

beforeAll(async () => {
  [answer, correct, sparse, blank] = await Promise.all([
    pagesOf('student-answer'),
    pagesOf('fully-correct'),
    pagesOf('incorrect'),
    pagesOf('blank'),
  ]);
});

function contains(
  region: { x: number; y: number; width: number; height: number },
  point: { x: number; y: number },
) {
  return (
    point.x >= region.x &&
    point.x <= region.x + region.width &&
    point.y >= region.y &&
    point.y <= region.y + region.height
  );
}

describe('finding the drawings on a page', () => {
  it('finds one drawing per page of the sample answer, and names it', () => {
    const regions = findAllDiagramRegions(answer);

    expect(regions.map((region) => region.caption)).toEqual([
      'Circuit diagram',
      'Demand and supply graph',
    ]);
    expect(regions.map((region) => region.page)).toEqual([0, 1]);
  });

  it('frames the whole circuit, including the meters at its edges', () => {
    const circuit = findDiagramByCaption(answer, 'Circuit diagram')!;

    // The ammeter label sits at the far right of the page, and the voltmeter
    // below the bottom wire. A box that misses either is the failure the model's
    // own coordinates kept producing.
    expect(contains(circuit, { x: 0.955, y: 0.456 })).toBe(true); // ammeter
    expect(contains(circuit, { x: 0.457, y: 0.551 })).toBe(true); // voltmeter
    expect(contains(circuit, { x: 0.185, y: 0.358 })).toBe(true); // battery
  });

  /*
   * The reason this is measured at all. A hardcoded box for the circuit once ran
   * from y 0.42 to 0.64 — it started below the drawing's own labels and finished
   * inside the English answer underneath, defacing an answer it said nothing
   * about.
   */
  it('stops before the answer that follows it', () => {
    const circuit = findDiagramByCaption(answer, 'Circuit diagram')!;
    const nextAnswer = answer[0]!.runs.find((run) => run.text.trim().startsWith('Answer 2'))!;

    expect(circuit.y + circuit.height).toBeLessThan(nextAnswer.rect.y);
  });

  it('reaches the axis drawn to the left of every label on it', () => {
    // The graph's vertical axis is left of the "10" that is its leftmost label,
    // so the caption's margin is what keeps the axis inside the box.
    const graph = findDiagramByCaption(answer, 'Demand and supply graph')!;

    expect(graph.x).toBeLessThan(0.1);
    expect(contains(graph, { x: 0.226, y: 0.518 })).toBe(true); // the "10"
    expect(contains(graph, { x: 0.592, y: 0.488 })).toBe(true); // the demand curve's "D"
  });

  it('keeps a label that sits on the left margin inside the drawing', () => {
    // "conventional current" is written at x 0.087, level with the body margin.
    // Read as prose it splits the circuit in two and the voltmeter falls out.
    const circuit = findDiagramByCaption(correct, 'Circuit diagram')!;

    expect(contains(circuit, { x: 0.09, y: 0.543 })).toBe(true); // the label itself
    expect(contains(circuit, { x: 0.6, y: 0.635 })).toBe(true); // the voltmeter below it
  });

  it('finds a drawing on a page that holds nothing else', () => {
    const graph = findDiagramByCaption(sparse, 'Demand and supply graph');

    expect(graph).not.toBeNull();
    expect(graph!.page).toBe(1);
  });

  it('reports no drawing on a blank answer sheet', () => {
    // The header — name, roll number, total — is three short runs side by side,
    // which is the shape of a row of diagram labels and is not one.
    expect(findDiagramRegions(blank[0]!)).toEqual([]);
  });

  it('never reports a box that leaves the page', () => {
    for (const pages of [answer, correct, sparse]) {
      for (const region of findAllDiagramRegions(pages)) {
        expect(region.x).toBeGreaterThanOrEqual(0);
        expect(region.y).toBeGreaterThanOrEqual(0);
        expect(region.x + region.width).toBeLessThanOrEqual(1);
        expect(region.y + region.height).toBeLessThanOrEqual(1);
        expect(region.width).toBeGreaterThan(0);
        expect(region.height).toBeGreaterThan(0);
      }
    }
  });
});
