import { describe, expect, it } from 'vitest';
import type { DraftQuestion } from '@gradesense/shared';
import { RubricSchema } from '@gradesense/shared';
import { extractRubric } from './extract.js';
import { inferCriteria } from './infer-criteria.js';
import { MockGradingModel } from '../grading/providers/mock.js';
import type { CriteriaInferenceInput, GradingModel, ModelResponse } from '../grading/model.js';

/**
 * Criteria inference, for questions whose marking scheme defined none.
 *
 * Two properties are load-bearing and both are asserted here: inferred marks sum
 * to the total the instructor stated, and the result is labelled `ai-inferred`
 * so it can never be presented as the teacher's own rubric.
 */

const question: DraftQuestion = {
  id: 'q2',
  number: 2,
  subject: 'History',
  maxMarks: 4,
  prompt: 'Explain the consequences of the Treaty of Versailles.',
  modelAnswer:
    'The treaty was signed in 1919. It imposed heavy reparations on Germany, which contributed to economic hardship in the Weimar Republic and to political instability.',
  guidance: [],
  requiresDiagram: false,
  criteriaSource: 'instructor',
  criteria: [],
};

/** Returns whatever criteria the test asks for, standing in for a real model. */
function providerReturning(criteria: Array<{ description: string; maxMarks: number }>): GradingModel {
  return {
    providerName: 'stub',
    modelName: 'stub',
    gradeQuestion: async () => ({ data: null, raw: '' }),
    inferCriteria: async (_input: CriteriaInferenceInput): Promise<ModelResponse> => ({
      data: { criteria },
      raw: JSON.stringify({ criteria }),
    }),
  };
}

describe('inferring criteria for a question with no rubric', () => {
  it('uses the model and labels the result as inferred', async () => {
    const result = await inferCriteria(
      question,
      providerReturning([
        { description: 'States the treaty was signed in 1919', maxMarks: 1 },
        { description: 'Identifies the reparations imposed on Germany', maxMarks: 2 },
        { description: 'Links the terms to Weimar instability', maxMarks: 1 },
      ]),
    );

    expect(result.method).toBe('model');
    expect(result.criteria).toHaveLength(3);
    expect(result.criteria.map((c) => c.id)).toEqual(['q2c1', 'q2c2', 'q2c3']);
    expect(result.warning).toMatch(/inferred from the model answer/i);
  });

  /*
   * The model is asked for marks summing to the stated total and usually
   * complies — but "usually" is not something a mark scheme can rest on, so the
   * sum is enforced rather than trusted, exactly as totals are everywhere else.
   */
  it('forces inferred marks to sum to the instructor\'s stated total', async () => {
    const result = await inferCriteria(
      question,
      providerReturning([
        { description: 'First point', maxMarks: 3 },
        { description: 'Second point', maxMarks: 3 },
        { description: 'Third point', maxMarks: 4 },
      ]),
    );

    const sum = result.criteria.reduce((total, criterion) => total + criterion.maxMarks, 0);
    expect(sum).toBeCloseTo(question.maxMarks, 6);
  });

  it('falls back to one placeholder point when the provider cannot infer', async () => {
    const result = await inferCriteria(question, new MockGradingModel());

    expect(result.method).toBe('fallback');
    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0]!.maxMarks).toBe(question.maxMarks);
    // The teacher is told plainly that they must write the criteria themselves.
    expect(result.warning).toMatch(/please write the criteria yourself/i);
  });

  it('falls back rather than failing when the provider throws', async () => {
    const broken: GradingModel = {
      providerName: 'broken',
      modelName: 'broken',
      gradeQuestion: async () => ({ data: null, raw: '' }),
      inferCriteria: async () => {
        throw new Error('upstream exploded');
      },
    };

    const result = await inferCriteria(question, broken);
    expect(result.method).toBe('fallback');
  });

  it('falls back when the provider returns nothing usable', async () => {
    const result = await inferCriteria(question, providerReturning([]));
    expect(result.method).toBe('fallback');
  });
});

describe('a scheme that rubrics some questions and not others', () => {
  const partialScheme = [
    'Q1 — Science',
    'Model Answer — 3 marks',
    'A circuit is a closed conducting path.',
    'Marking rubric',
    'Criterion Marks',
    'Describes a closed conducting path 2',
    'Names the components 1',
    'Total 3',
    'Q2 — History',
    'Model Answer — 4 marks',
    'The treaty was signed in 1919 and imposed reparations on Germany.',
  ].join('\n');

  const asDocument = (text: string) => ({
    id: 'doc',
    kind: 'model_answer' as const,
    filename: 'scheme.pdf',
    byteLength: text.length,
    sha256: 'x',
    pageCount: 1,
    pages: [],
    fullText: text,
    createdAt: new Date().toISOString(),
  });

  it('keeps both questions, marking only the unrubricked one as inferred', async () => {
    const draft = await extractRubric({
      modelAnswer: asDocument(partialScheme),
      questionPaper: null,
      model: new MockGradingModel(),
    });

    expect(draft.rubric.questions).toHaveLength(2);
    expect(draft.rubric.questions[0]!.criteriaSource).toBe('instructor');
    expect(draft.rubric.questions[1]!.criteriaSource).toBe('ai-inferred');

    // The instructor's own question is untouched by any of this.
    expect(draft.rubric.questions[0]!.criteria).toHaveLength(2);
    expect(draft.rubric.questions[0]!.maxMarks).toBe(3);
  });

  it('produces a rubric that is valid and adds up', async () => {
    const draft = await extractRubric({
      modelAnswer: asDocument(partialScheme),
      questionPaper: null,
      model: new MockGradingModel(),
    });

    expect(RubricSchema.safeParse(draft.rubric).success).toBe(true);
    expect(draft.rubric.totalMarks).toBe(7);
  });

  it('warns about the inferred question by name', async () => {
    const draft = await extractRubric({
      modelAnswer: asDocument(partialScheme),
      questionPaper: null,
      model: new MockGradingModel(),
    });

    expect(draft.warnings.join(' ')).toMatch(/Question 2/);
  });
});
