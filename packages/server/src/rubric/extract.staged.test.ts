import { describe, expect, it } from 'vitest';
import type { IngestedDocument, PageText } from '@gradesense/shared';
import { RequestTooLargeError } from '../errors.js';
import type {
  AnswerChunkInput,
  DocumentChunkInput,
  GradeQuestionInput,
  GradingModel,
  ModelAttemptContext,
  ModelResponse,
} from '../grading/model.js';
import { estimateTokens } from '../grading/tokens.js';
import { extractRubric } from './extract.js';

/**
 * The staged route, end to end, with a scripted model.
 *
 * The fake reads each excerpt the way a well-behaved model would — it reports
 * the questions whose headings it can see — so the test is about the pipeline:
 * that both documents are read in pieces, that no request carries a whole
 * document, that the pieces are joined by number, and that a refused request is
 * split rather than failed.
 */

const filler = (label: string, words: number) =>
  Array.from({ length: words }, (_, i) => `${label}${i}`).join(' ');

const page = (text: string): PageText => ({ text, runs: [], width: 595, height: 842 }) as unknown as PageText;

function document(kind: IngestedDocument['kind'], filename: string, pages: string[]): IngestedDocument {
  return {
    id: `${kind}-id`,
    kind,
    filename,
    byteLength: 1,
    sha256: 'x',
    pageCount: pages.length,
    pages: pages.map(page),
    fullText: pages.join('\n'),
    createdAt: new Date().toISOString(),
  };
}

/** Long enough that the default chunk size (12,000 tokens under the mock provider) is exceeded several times over. */
const BULK = 9_000;

const questionPaper = document('question_paper', 'qp.pdf', [
  `PHYSICS (Theory)\nSECTION – E\n31. (a) Derive the field of a dipole on the equatorial plane. ${filler('qa', BULK)}\n(b) Calculate the force and torque. 5`,
  `32. (a) Derive the lens maker's formula. ${filler('qb', BULK)}\n(b) Find the final image distance. 5`,
  `33. (a) State Faraday's law. ${filler('qc', BULK)}\n(c) Find the emf induced in the rod. 5`,
]);

const markingScheme = document('model_answer', 'ms.pdf', [
  `MARKING SCHEME\n31\nDeriving the expression 2½ ${filler('ma', BULK)}\nCalculating force and torque 2`,
  `32\nDeriving lens maker's formula 3 ${filler('mb', BULK)}\nFinding the image distance 2`,
  `33\nStating Faraday's law 1 ${filler('mc', BULK)}\nDeriving self-inductance 2\nFinding the induced emf 2`,
]);

interface Seen {
  paperChunks: DocumentChunkInput[];
  schemeChunks: DocumentChunkInput[];
}

/** Answers from the headings in each excerpt. Knows the three questions' marking by heart. */
function scriptedModel(options: { refuseAbove?: number } = {}): GradingModel & Seen {
  const seen: Seen = { paperChunks: [], schemeChunks: [] };
  const numbersIn = (text: string) =>
    [...text.matchAll(/(?:^|\n)\s*(3[1-3])\b/g)].map((match) => Number(match[1]));

  const refuseIfTooBig = (chunk: DocumentChunkInput['chunk']) => {
    if (options.refuseAbove !== undefined && estimateTokens(chunk.text) > options.refuseAbove) {
      throw new RequestTooLargeError('scripted refusal', estimateTokens(chunk.text), options.refuseAbove);
    }
  };

  const criteriaFor: Record<number, Array<{ description: string; maxMarks: number }>> = {
    31: [
      { description: 'Deriving the expression', maxMarks: 2.5 },
      { description: 'Writing the far-field expression', maxMarks: 0.5 },
      { description: 'Calculating force and torque', maxMarks: 2 },
    ],
    32: [
      { description: "Deriving lens maker's formula", maxMarks: 3 },
      { description: 'Finding the image distance', maxMarks: 2 },
    ],
    33: [
      { description: "Stating Faraday's law", maxMarks: 1 },
      { description: 'Deriving self-inductance', maxMarks: 2 },
      { description: 'Finding the induced emf', maxMarks: 2 },
    ],
  };

  return {
    ...seen,
    providerName: 'scripted',
    modelName: 'scripted',
    async gradeQuestion(_input: GradeQuestionInput, _context: ModelAttemptContext): Promise<ModelResponse> {
      throw new Error('not used here');
    },
    async extractQuestionPaperChunk(input) {
      refuseIfTooBig(input.chunk);
      seen.paperChunks.push(input);
      const questions = numbersIn(input.chunk.text).map((number) => ({
        number,
        subject: 'Physics',
        prompt: `Question ${number} as set`,
        maxMarks: 5,
        requiresDiagram: false,
        continuesFromPreviousChunk: input.chunk.part ? input.chunk.part.index > 0 : false,
        continuesIntoNextChunk: false,
      }));
      return { data: { questions }, raw: JSON.stringify({ questions }) };
    },
    async extractSchemeChunk(input) {
      refuseIfTooBig(input.chunk);
      seen.schemeChunks.push(input);
      const questions = numbersIn(input.chunk.text).map((number) => ({
        number,
        maxMarks: 5,
        modelAnswer: `Worked answer ${number}`,
        guidance: ['Award full marks for any other correct method'],
        requiresDiagram: false,
        criteria: criteriaFor[number]!,
        continuesFromPreviousChunk: false,
        continuesIntoNextChunk: false,
      }));
      return { data: { questions }, raw: JSON.stringify({ questions }) };
    },
    async attributeAnswerChunk(_input: AnswerChunkInput): Promise<ModelResponse> {
      throw new Error('not used here');
    },
  };
}

describe('staged rubric extraction', () => {
  it('reads both documents in pieces and joins them by question number', async () => {
    const model = scriptedModel();

    const draft = await extractRubric({ modelAnswer: markingScheme, questionPaper, model });

    // Several requests per document, none carrying the whole thing.
    expect(model.paperChunks.length).toBeGreaterThan(1);
    expect(model.schemeChunks.length).toBeGreaterThan(1);
    for (const input of [...model.paperChunks, ...model.schemeChunks]) {
      expect(input.chunk.text.length).toBeLessThan(questionPaper.fullText.length);
    }
    // The scheme was read knowing what the paper contains.
    expect(model.schemeChunks[0]!.knownQuestions.map((q) => q.number)).toEqual([31, 32, 33]);

    expect(draft.source).toBe('model');
    expect(draft.rubric.questions.map((q) => q.number)).toEqual([31, 32, 33]);
    expect(draft.rubric.totalMarks).toBe(15);

    const q33 = draft.rubric.questions.find((q) => q.number === 33)!;
    expect(q33.prompt).toBe('Question 33 as set');
    // The worked answer is the scheme's own text for Q33, not the model's copy.
    expect(q33.modelAnswer).toContain("Stating Faraday's law 1");
    expect(q33.modelAnswer).toContain('Finding the induced emf 2');
    expect(q33.modelAnswer).not.toContain('Deriving lens maker');
    expect(q33.criteria.map((c) => c.maxMarks)).toEqual([1, 2, 2]);
    expect(q33.criteria.map((c) => c.id)).toEqual(['q33c1', 'q33c2', 'q33c3']);
    expect(q33.guidance).toEqual(['Award full marks for any other correct method']);
    expect(q33.criteriaSource).toBe('instructor');

    expect(draft.warnings.some((w) => w.startsWith('Read in pieces:'))).toBe(true);
  });

  it('splits an excerpt the provider refuses and still reads everything', async () => {
    const model = scriptedModel({ refuseAbove: 4_000 });

    const draft = await extractRubric({ modelAnswer: markingScheme, questionPaper, model });

    expect(draft.rubric.questions.map((q) => q.number)).toEqual([31, 32, 33]);
    for (const input of [...model.paperChunks, ...model.schemeChunks]) {
      expect(estimateTokens(input.chunk.text)).toBeLessThanOrEqual(4_000);
    }
    // Some of the successful reads were parts of a split chunk.
    expect(model.schemeChunks.some((input) => input.chunk.part !== null)).toBe(true);
  });

  it('works from the marking scheme alone when no question paper is uploaded', async () => {
    const model = scriptedModel();

    const draft = await extractRubric({ modelAnswer: markingScheme, questionPaper: null, model });

    expect(model.paperChunks).toHaveLength(0);
    expect(draft.rubric.questions.map((q) => q.number)).toEqual([31, 32, 33]);
    expect(draft.rubric.questions[0]!.prompt).toBe('');
  });
});
