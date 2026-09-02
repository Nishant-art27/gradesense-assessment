import crypto from 'node:crypto';
import {
  RubricSchema,
  validateRubricArithmetic,
  type DraftRubric,
  type IngestedDocument,
  type Rubric,
} from '@gradesense/shared';
import { RubricInvalidError } from '../errors.js';
import type { GradingModel } from '../grading/model.js';
import { asModelFailure } from '../grading/providers/transient.js';
import { buildRubric } from './parse-scheme.js';
import { inferCriteria } from './infer-criteria.js';

/**
 * Turning an uploaded marking scheme into a rubric.
 *
 * Two routes, tried in order:
 *
 *  1. **Structural parsing.** Marking schemes are laid out consistently enough
 *     to read exactly. When that works it is free, instant, deterministic and
 *     not capable of inventing a criterion that was never there.
 *  2. **The model.** For a scheme laid out in some way the parser does not
 *     recognise. Slower, costs a call, and needs the same validation applied to
 *     everything else a model produces.
 *
 * Whichever route produced it, the result is a **draft**. The rubric is the
 * specification every subsequent mark is measured against, so a mistake here is
 * multiplied by the size of the class. A human confirms it before it is used —
 * one review protects the whole batch.
 */

export interface RubricDraft {
  rubric: Rubric;
  /** How it was produced, so the UI can say so plainly. */
  source: 'parsed' | 'model';
  /** Things worth a human's attention. Never fatal on their own. */
  warnings: string[];
}

export interface ExtractRubricInput {
  modelAnswer: IngestedDocument;
  questionPaper: IngestedDocument | null;
  model: GradingModel;
}

export async function extractRubric(input: ExtractRubricInput): Promise<RubricDraft> {
  const { modelAnswer, questionPaper, model } = input;

  const id = `rubric-${crypto.randomUUID()}`;
  const title = deriveTitle(questionPaper, modelAnswer);

  // 1. Deterministic parse.
  const parsed = buildRubric(modelAnswer.fullText, questionPaper?.fullText ?? null, { id, title });
  if (parsed.rubric) {
    const filled = await fillMissingCriteria(parsed.rubric, model);
    return finalise(filled.rubric, 'parsed', [...parsed.warnings, ...filled.warnings]);
  }

  // 2. Ask the model, if this provider can do it.
  if (!model.extractRubric) {
    throw new RubricInvalidError(
      'The marking scheme could not be read automatically, and the current grading provider cannot extract one.',
      [
        ...parsed.warnings,
        'Set MODEL_PROVIDER=anthropic to have the model read a scheme this parser does not recognise.',
      ],
    );
  }

  let response;
  try {
    response = await model.extractRubric({
      modelAnswerText: modelAnswer.fullText,
      modelAnswerPdfBase64: null,
      questionPaperText: questionPaper?.fullText ?? null,
    });
  } catch (error) {
    // Same reason as in the grading pipeline: a rejected key must read as a
    // rejected key, not as the provider's raw error body.
    throw asModelFailure(error, model.providerName);
  }

  const validated = RubricSchema.safeParse(withIdentity(response.data, id, title));
  if (!validated.success) {
    throw new RubricInvalidError('The model returned a rubric that did not match the expected shape.', [
      ...parsed.warnings,
      ...validated.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    ]);
  }

  return finalise(validated.data, 'model', [
    ...parsed.warnings,
    'This rubric was read by the language model rather than parsed directly. Check it carefully.',
  ]);
}

/**
 * Fills in criteria for any question whose scheme defined none.
 *
 * The absence of a rubric for one question must never stop the rest of the paper
 * being graded, so this runs per question and leaves everything else untouched.
 * Anything it fills in is marked `ai-inferred` from here to the UI.
 */
async function fillMissingCriteria(
  rubric: DraftRubric,
  model: GradingModel,
): Promise<{ rubric: DraftRubric; warnings: string[] }> {
  const warnings: string[] = [];

  const questions = await Promise.all(
    rubric.questions.map(async (question) => {
      if (question.criteria.length > 0) return question;

      const inferred = await inferCriteria(question, model);
      warnings.push(inferred.warning);

      return { ...question, criteria: inferred.criteria, criteriaSource: 'ai-inferred' as const };
    }),
  );

  return { rubric: { ...rubric, questions }, warnings };
}

/**
 * Last gate before a rubric is offered to the user.
 *
 * Arithmetic is repaired rather than rejected: a question whose stated total
 * disagrees with its criteria is set to the sum of its criteria, because the
 * criteria are what marks are actually awarded against. Every repair is reported.
 */
function finalise(rubric: DraftRubric, source: RubricDraft['source'], warnings: string[]): RubricDraft {
  const repaired = {
    ...rubric,
    questions: rubric.questions.map((question) => {
      const sum = question.criteria.reduce((total, criterion) => total + criterion.maxMarks, 0);
      return question.maxMarks === sum ? question : { ...question, maxMarks: sum };
    }),
  };
  repaired.totalMarks = repaired.questions.reduce((total, question) => total + question.maxMarks, 0);

  // Only now is the strict schema applied: by this point every question has at
  // least one criterion, whether the instructor's or inferred.
  const strict = RubricSchema.safeParse(repaired);
  if (!strict.success) {
    throw new RubricInvalidError('The rubric could not be completed.', [
      ...warnings,
      ...strict.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    ]);
  }

  const problems = validateRubricArithmetic(strict.data);
  if (problems.length > 0) {
    throw new RubricInvalidError('The extracted rubric does not add up and cannot be used.', [
      ...warnings,
      ...problems,
    ]);
  }

  if (strict.data.questions.length === 0) {
    throw new RubricInvalidError('The extracted rubric has no questions.', warnings);
  }

  return { rubric: strict.data, source, warnings };
}

/**
 * Fills in everything the model was not asked for.
 *
 * The extraction schema deliberately omits ids, the paper total, and per-question
 * totals. Those are derivable, and a model asked to invent an identifier only
 * creates something to reconcile against the criteria later. Assigning them here
 * means the ids are always well-formed and the totals always agree with the
 * criteria they are computed from.
 */
function withIdentity(data: unknown, id: string, title: string): unknown {
  if (typeof data !== 'object' || data === null) return data;

  const raw = data as { questions?: unknown };
  if (!Array.isArray(raw.questions)) return { ...(data as object), id, title };

  const questions = raw.questions.map((entry, index) => {
    const question = (entry ?? {}) as Record<string, unknown>;
    const number = typeof question.number === 'number' ? question.number : index + 1;
    const rawCriteria = Array.isArray(question.criteria) ? question.criteria : [];

    const criteria = rawCriteria.map((criterionEntry, criterionIndex) => {
      const criterion = (criterionEntry ?? {}) as Record<string, unknown>;
      return {
        id: `q${number}c${criterionIndex + 1}`,
        description: criterion.description,
        maxMarks: criterion.maxMarks,
      };
    });

    const maxMarks = criteria.reduce(
      (total, criterion) => total + (typeof criterion.maxMarks === 'number' ? criterion.maxMarks : 0),
      0,
    );

    return { ...question, id: `q${number}`, number, maxMarks, criteria };
  });

  const totalMarks = questions.reduce((total, question) => total + question.maxMarks, 0);
  return { id, title, totalMarks, questions };
}

function deriveTitle(questionPaper: IngestedDocument | null, modelAnswer: IngestedDocument): string {
  const source = questionPaper ?? modelAnswer;
  const firstLine = source.fullText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 6 && line.length < 90);

  return firstLine ?? source.filename.replace(/\.pdf$/i, '');
}
