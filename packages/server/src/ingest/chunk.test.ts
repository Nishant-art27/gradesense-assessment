import { describe, expect, it } from 'vitest';
import type { PageText } from '@gradesense/shared';
import { estimateTokens } from '../grading/tokens.js';
import { chunkDocument, questionTexts, splitChunk, splitText } from './chunk.js';

const page = (text: string): PageText => ({ text, runs: [], width: 595, height: 842 }) as unknown as PageText;

const paragraph = (label: string, sentences: number) =>
  Array.from({ length: sentences }, (_, i) => `${label} sentence ${i + 1} about the physics involved.`).join(' ');

describe('chunkDocument', () => {
  it('keeps a question together with the text under it', () => {
    const pages = [
      page(`SECTION – E\n31. (a) Derive the expression.\n${paragraph('Q31', 6)}\n(b) Calculate the torque.\n${paragraph('Q31b', 6)}`),
      page(`32. (a) Derive the lens maker formula.\n${paragraph('Q32', 6)}\n33. State Faraday's law.\n${paragraph('Q33', 6)}`),
    ];

    const chunks = chunkDocument(pages, { maxTokens: 260 });

    // No chunk begins in the middle of a question's body.
    for (const chunk of chunks) {
      expect(chunk.text).not.toMatch(/^Q3\d sentence/);
    }
    // Every question heading appears exactly once across all chunks.
    const headings = chunks.flatMap((chunk) => chunk.questionNumbers);
    expect(headings).toEqual([31, 32, 33]);
    // Nothing was lost.
    const joined = chunks.map((chunk) => chunk.text).join('\n');
    for (const needle of ['Q31 sentence 6', 'Q31b sentence 6', 'Q32 sentence 6', 'Q33 sentence 6']) {
      expect(joined).toContain(needle);
    }
  });

  it('records page range, section and question numbers on each chunk', () => {
    const pages = [page('SECTION – E\n31. First question text.'), page('32. Second question text.')];
    const chunks = chunkDocument(pages, { maxTokens: 10_000 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      index: 0,
      total: 1,
      startPage: 0,
      endPage: 1,
      section: 'SECTION – E',
      questionNumbers: [31, 32],
      part: null,
    });
  });

  it('splits a single oversized question at its sub-parts and labels the parts', () => {
    const body = `31. (a) ${paragraph('A', 20)}\n(b) ${paragraph('B', 20)}\n(c) ${paragraph('C', 20)}`;
    const chunks = chunkDocument([page(body)], { maxTokens: 300 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(300);
      expect(chunk.questionNumbers).toEqual([31]);
      expect(chunk.part).not.toBeNull();
    }
    expect(chunks[0]!.text.startsWith('31. (a)')).toBe(true);
    expect(chunks.some((chunk) => chunk.text.startsWith('(b)'))).toBe(true);
    expect(chunks.every((chunk) => chunk.part!.count === chunks.length)).toBe(true);
  });

  it('does not treat a numbered list inside an answer as a return to question 1', () => {
    const body = `31. Explain the two processes.\n1. Diffusion happens first.\n2. Drift follows.\n32. Next question.`;
    const chunks = chunkDocument([page(body)], { maxTokens: 10_000 });

    expect(chunks[0]!.questionNumbers).toEqual([31, 32]);
  });

  it('accepts a bare number as a heading only when told to expect it', () => {
    const body = `31\nValue points for thirty-one.\n7\nNot a heading, just a stray page number.\n32\nValue points for thirty-two.`;

    const blind = chunkDocument([page(body)], { maxTokens: 10_000 });
    expect(blind[0]!.questionNumbers).toEqual([]);

    const informed = chunkDocument([page(body)], { maxTokens: 10_000, expectedNumbers: [31, 32, 33] });
    expect(informed[0]!.questionNumbers).toEqual([31, 32]);
  });

  it('never returns an empty chunk', () => {
    const chunks = chunkDocument([page(''), page('\n\n'), page('31. Only content.')], { maxTokens: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('31. Only content.');
  });

  it('stays under the limit even for a single enormous line', () => {
    const line = Array.from({ length: 800 }, (_, i) => `token${i}`).join(' ');
    const chunks = chunkDocument([page(line)], { maxTokens: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.estimatedTokens).toBeLessThanOrEqual(200);
    expect(chunks.map((chunk) => chunk.text).join(' ')).toContain('token799');
  });
});

describe('splitChunk', () => {
  it('halves a chunk the provider still refused, keeping its metadata', () => {
    const chunk = chunkDocument([page(`31. ${paragraph('A', 10)}\n\n${paragraph('B', 10)}`)], { maxTokens: 10_000 })[0]!;
    const halves = splitChunk(chunk, Math.floor(chunk.estimatedTokens / 2));

    expect(halves.length).toBeGreaterThanOrEqual(2);
    for (const half of halves) {
      expect(half.questionNumbers).toEqual([31]);
      expect(half.part).not.toBeNull();
    }
    expect(halves.map((half) => half.text).join('\n')).toContain('B sentence 10');
  });
});

describe('splitText', () => {
  it('returns the text whole when it fits', () => {
    expect(splitText('short answer', 100)).toEqual(['short answer']);
  });

  it('cuts a long answer at paragraph boundaries under the limit', () => {
    const text = `${paragraph('P1', 15)}\n\n${paragraph('P2', 15)}\n\n${paragraph('P3', 15)}`;
    const limit = Math.ceil(estimateTokens(text) / 2);
    const pieces = splitText(text, limit);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(estimateTokens(piece)).toBeLessThanOrEqual(limit);
    expect(pieces.join('\n')).toContain('P3 sentence 15');
  });
});

describe('questionTexts', () => {
  it('slices the document at the question headings, keeping everything between them', () => {
    const pages = [
      page('MARKING SCHEME\n31\nDeriving the field 2½\nOR\nEquivalent emf 2'),
      page('32\nLens maker 3\nNote: award full marks for any other method\n33\nFaraday 1'),
    ];
    const texts = questionTexts(pages, [31, 32, 33]);

    expect(texts.get(31)).toBe('31\nDeriving the field 2½\nOR\nEquivalent emf 2');
    expect(texts.get(32)).toBe('32\nLens maker 3\nNote: award full marks for any other method');
    expect(texts.get(33)).toBe('33\nFaraday 1');
    expect(texts.has(30)).toBe(false);
  });
});
