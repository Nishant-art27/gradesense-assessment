import { z } from 'zod';

/**
 * A single markable point. The rubric in the provided model-answer paper uses
 * 1 mark per criterion, but nothing here assumes that.
 */
export const CriterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  maxMarks: z.number().positive(),
});

/**
 * Where a question's markable points came from.
 *
 * `instructor` — read from the marking scheme the teacher uploaded.
 * `ai-inferred` — the scheme had no rubric for this question, so criteria were
 *   derived from the question and the model answer.
 *
 * These must never be conflated. A teacher deciding whether to trust a mark
 * needs to know whether the standard it was measured against is theirs or the
 * machine's, and inferred criteria are shown as such everywhere they appear.
 */
export const CRITERIA_SOURCES = ['instructor', 'ai-inferred'] as const;
export type CriteriaSource = (typeof CRITERIA_SOURCES)[number];

export const QuestionSchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  subject: z.string(),
  prompt: z.string(),
  maxMarks: z.number().positive(),
  /** Prose model answer, used as grading context — never as a similarity target. */
  modelAnswer: z.string(),
  /**
   * Question-specific marking guidance lifted from the model-answer paper, e.g.
   * "a student may reach the opposite conclusion and still score full marks".
   * These guard against the grader rewarding similarity over reasoning.
   */
  guidance: z.array(z.string()).default([]),
  /** True when a diagram/graph carries some of the marks. Drives vision grading. */
  requiresDiagram: z.boolean().default(false),
  /** Defaults to instructor, so a hand-written rubric needs no extra field. */
  criteriaSource: z.enum(CRITERIA_SOURCES).default('instructor'),
  criteria: z.array(CriterionSchema).min(1),
});

export const RubricSchema = z.object({
  id: z.string(),
  title: z.string(),
  totalMarks: z.number().positive(),
  questions: z.array(QuestionSchema).min(1),
});

/**
 * A rubric between parsing and inference, where a question may still have no
 * criteria. Nothing is ever graded or saved in this state — `RubricSchema` keeps
 * its `min(1)`, so the looser shape cannot leak past `extractRubric`.
 */
export const DraftQuestionSchema = QuestionSchema.extend({
  criteria: z.array(CriterionSchema),
});
export const DraftRubricSchema = RubricSchema.extend({
  questions: z.array(DraftQuestionSchema),
});
export type DraftQuestion = z.infer<typeof DraftQuestionSchema>;
export type DraftRubric = z.infer<typeof DraftRubricSchema>;

export type Criterion = z.infer<typeof CriterionSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Rubric = z.infer<typeof RubricSchema>;

/**
 * A rubric is only usable if its arithmetic is internally consistent. A rubric
 * whose criteria do not sum to the question maximum would make it impossible to
 * honour the "total equals the sum of the rubric points" rule, so we refuse it
 * at load time rather than producing quietly wrong totals later.
 */
export function validateRubricArithmetic(rubric: Rubric): string[] {
  const problems: string[] = [];

  for (const question of rubric.questions) {
    const sum = question.criteria.reduce((acc, c) => acc + c.maxMarks, 0);
    if (Math.abs(sum - question.maxMarks) > 1e-9) {
      problems.push(
        `Question ${question.number}: criteria sum to ${sum} but the question is worth ${question.maxMarks}.`,
      );
    }

    const ids = question.criteria.map((c) => c.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (duplicates.length > 0) {
      problems.push(`Question ${question.number}: duplicate criterion ids ${duplicates.join(', ')}.`);
    }
  }

  const paperSum = rubric.questions.reduce((acc, q) => acc + q.maxMarks, 0);
  if (Math.abs(paperSum - rubric.totalMarks) > 1e-9) {
    problems.push(`Paper: questions sum to ${paperSum} but the paper is worth ${rubric.totalMarks}.`);
  }

  return problems;
}
