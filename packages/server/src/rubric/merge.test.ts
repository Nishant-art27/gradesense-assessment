import { describe, expect, it } from 'vitest';
import { joinQuestions, mergeQuestionPaperParts, mergeSchemeParts } from './merge.js';

/**
 * The join key is the question number, never document position. These tests
 * pin that down: a question cut by a chunk boundary reassembles, repeats at the
 * seam collapse, and a question present in one document only is reported.
 */

describe('mergeQuestionPaperParts', () => {
  it('reassembles a question that straddles two excerpts', () => {
    const merged = mergeQuestionPaperParts([
      {
        chunkIndex: 0,
        entry: {
          number: 31,
          subject: 'Physics',
          prompt: '(a) Derive the field on the equatorial plane.',
          maxMarks: 5,
          requiresDiagram: false,
          continuesFromPreviousChunk: false,
          continuesIntoNextChunk: true,
        },
      },
      {
        chunkIndex: 1,
        entry: {
          number: 31,
          subject: '',
          prompt: '(b) Calculate the force and torque.',
          maxMarks: null,
          requiresDiagram: false,
          continuesFromPreviousChunk: true,
          continuesIntoNextChunk: false,
        },
      },
    ]);

    const q31 = merged.get(31)!;
    expect(q31.prompt).toBe('(a) Derive the field on the equatorial plane.\n(b) Calculate the force and torque.');
    expect(q31.maxMarks).toBe(5);
    expect(q31.subject).toBe('Physics');
    expect(q31.chunkIndices).toEqual([0, 1]);
  });

  it('does not duplicate a prompt repeated at the seam', () => {
    const entry = {
      number: 32,
      subject: 'Physics',
      prompt: 'Derive the lens maker formula.',
      maxMarks: 5,
      requiresDiagram: false,
      continuesFromPreviousChunk: false,
      continuesIntoNextChunk: false,
    };
    const merged = mergeQuestionPaperParts([
      { chunkIndex: 0, entry },
      { chunkIndex: 1, entry: { ...entry, continuesFromPreviousChunk: true } },
    ]);
    expect(merged.get(32)!.prompt).toBe('Derive the lens maker formula.');
  });
});

describe('mergeSchemeParts', () => {
  it('appends criteria in order and keeps guidance from every excerpt once', () => {
    const merged = mergeSchemeParts([
      {
        chunkIndex: 2,
        entry: {
          number: 33,
          maxMarks: 5,
          modelAnswer: 'ε = -dΦ/dt',
          guidance: ['Award full marks for any other correct method'],
          requiresDiagram: false,
          criteria: [
            { description: "Stating Faraday's law", maxMarks: 1 },
            { description: 'Flux linked N Φ = μ0 n² A l I', maxMarks: 0.5 },
          ],
          continuesFromPreviousChunk: false,
          continuesIntoNextChunk: true,
        },
      },
      {
        chunkIndex: 3,
        entry: {
          number: 33,
          maxMarks: null,
          modelAnswer: 'L = μ0 n² A l',
          guidance: ['Award full marks for any other correct method', 'Alternatively: ε = ½ B l² ω'],
          requiresDiagram: false,
          criteria: [
            { description: 'Flux linked N Φ = μ0 n² A l I', maxMarks: 0.5 },
            { description: 'L = μ0 n² A l', maxMarks: 0.5 },
            { description: 'Induced emf = 3.14 mV', maxMarks: 0.5 },
          ],
          continuesFromPreviousChunk: true,
          continuesIntoNextChunk: false,
        },
      },
    ]);

    const q33 = merged.get(33)!;
    expect(q33.criteria.map((c) => c.description)).toEqual([
      "Stating Faraday's law",
      'Flux linked N Φ = μ0 n² A l I',
      'L = μ0 n² A l',
      'Induced emf = 3.14 mV',
    ]);
    expect(q33.guidance).toEqual([
      'Award full marks for any other correct method',
      'Alternatively: ε = ½ B l² ω',
    ]);
    expect(q33.modelAnswer).toBe('ε = -dΦ/dt\nL = μ0 n² A l');
    expect(q33.maxMarks).toBe(5);
  });

  it('keeps two points with the same wording but different marks', () => {
    const merged = mergeSchemeParts([
      {
        chunkIndex: 0,
        entry: {
          number: 1,
          maxMarks: 1.5,
          modelAnswer: '',
          guidance: [],
          requiresDiagram: false,
          criteria: [
            { description: 'Correct formula', maxMarks: 1 },
            { description: 'Correct formula', maxMarks: 0.5 },
          ],
          continuesFromPreviousChunk: false,
          continuesIntoNextChunk: false,
        },
      },
    ]);
    expect(merged.get(1)!.criteria).toHaveLength(2);
  });
});

describe('joinQuestions', () => {
  const paperEntry = (number: number, maxMarks: number | null) => ({
    number,
    subject: 'Physics',
    prompt: `Question ${number} text`,
    maxMarks,
    requiresDiagram: false,
    chunkIndices: [0],
  });
  const schemeEntry = (number: number, maxMarks: number | null, criteriaMarks: number[]) => ({
    number,
    maxMarks,
    modelAnswer: `Answer ${number}`,
    guidance: [],
    requiresDiagram: false,
    criteria: criteriaMarks.map((marks, i) => ({ description: `Point ${i + 1}`, maxMarks: marks })),
    chunkIndices: [1],
  });

  it('pairs text with marking by number and takes the total from the scheme first', () => {
    const paper = new Map([[31, paperEntry(31, 5)]]);
    const scheme = new Map([[31, schemeEntry(31, 5, [2.5, 0.5, 2])]]);

    const { questions, warnings } = joinQuestions(paper, scheme, 'General');

    expect(warnings).toEqual([]);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      number: 31,
      prompt: 'Question 31 text',
      modelAnswer: 'Answer 31',
      maxMarks: 5,
      sources: { questionPaperChunks: [0], schemeChunks: [1] },
    });
    expect(questions[0]!.criteria).toHaveLength(3);
  });

  it('reports a question present in only one document', () => {
    const paper = new Map([
      [31, paperEntry(31, 5)],
      [32, paperEntry(32, 5)],
    ]);
    const scheme = new Map([
      [31, schemeEntry(31, 5, [5])],
      [33, schemeEntry(33, 5, [5])],
    ]);

    const { questions, warnings } = joinQuestions(paper, scheme, 'General');

    expect(questions.map((q) => q.number)).toEqual([31, 32, 33]);
    expect(warnings.some((w) => w.startsWith('Question 32 is on the question paper but'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('Question 33 is in the marking scheme but'))).toBe(true);
    // Q32 has no scheme: criteria are left empty for inference downstream.
    expect(questions.find((q) => q.number === 32)!.criteria).toEqual([]);
  });

  it('falls back to the sum of the criteria when neither document states a total', () => {
    const scheme = new Map([[5, schemeEntry(5, null, [1, 1, 1])]]);
    const { questions } = joinQuestions(new Map(), scheme, 'General');
    expect(questions[0]!.maxMarks).toBe(3);
  });

  it('leaves out, and says so, a question with no marks anywhere', () => {
    const paper = new Map([[9, paperEntry(9, null)]]);
    const { questions, warnings } = joinQuestions(paper, new Map(), 'General');
    expect(questions).toEqual([]);
    expect(warnings[0]).toMatch(/Question 9: no marks were stated/);
  });
});

describe('reconcileSummaryBox', () => {
  const box = [
    { description: 'Deriving the expression', maxMarks: 2.5 },
    { description: 'Far-field expression', maxMarks: 0.5 },
    { description: 'Force and torque', maxMarks: 2 },
  ];
  const steps = [
    { description: 'Labelled figure', maxMarks: 0.5 },
    { description: 'E+q', maxMarks: 0.5 },
    { description: 'E-q', maxMarks: 0.5 },
    { description: 'Resultant field', maxMarks: 1 },
    { description: 'r >> a limit', maxMarks: 0.5 },
    { description: 'F = 0', maxMarks: 1 },
    { description: 'τ = 0', maxMarks: 1 },
  ];

  it('drops a summary box that was listed alongside the steps, keeping the steps', async () => {
    const { reconcileSummaryBox } = await import('./merge.js');
    const out = reconcileSummaryBox([...box, ...steps], 5);

    expect(out.criteria).toEqual(steps);
    expect(out.criteria.reduce((t, c) => t + c.maxMarks, 0)).toBe(5);
    expect(out.guidance[0]).toMatch(/^Mark distribution from the scheme's summary: Deriving the expression — 2.5;/);
    expect(out.note).toMatch(/2.5 \+ 0.5 \+ 2 = 5/);
  });

  it('handles the box printed after the steps', async () => {
    const { reconcileSummaryBox } = await import('./merge.js');
    const out = reconcileSummaryBox([...steps, ...box], 5);
    expect(out.criteria).toEqual(steps);
  });

  it('leaves alone criteria that simply disagree with the stated total', async () => {
    const { reconcileSummaryBox } = await import('./merge.js');
    const odd = [{ description: 'a', maxMarks: 3 }, { description: 'b', maxMarks: 3 }, { description: 'c', maxMarks: 1 }];
    expect(reconcileSummaryBox(odd, 5)).toEqual({ criteria: odd, guidance: [], note: null });
    expect(reconcileSummaryBox(box, 5)).toEqual({ criteria: box, guidance: [], note: null });
    expect(reconcileSummaryBox([...box, ...steps], null)).toEqual({ criteria: [...box, ...steps], guidance: [], note: null });
  });

  it('is applied when questions are joined', () => {
    const scheme = new Map([
      [31, { number: 31, maxMarks: 5, modelAnswer: '', guidance: ['Any correct method'], requiresDiagram: false, criteria: [...box, ...steps], chunkIndices: [0] }],
    ]);
    const { questions, warnings } = joinQuestions(new Map(), scheme, 'Physics');
    expect(questions[0]!.maxMarks).toBe(5);
    expect(questions[0]!.criteria).toHaveLength(7);
    expect(questions[0]!.guidance).toEqual([expect.stringMatching(/^Mark distribution/), 'Any correct method']);
    expect(warnings.some((w) => w.startsWith('Question 31: the scheme\'s summary of marks'))).toBe(true);
  });
});
