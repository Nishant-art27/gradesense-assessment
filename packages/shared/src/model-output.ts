import { z } from 'zod';

/**
 * What the language model is asked to return for a single question.
 *
 * This schema is deliberately flatter and dumber than the internal domain model
 * in `./result.ts`. Everything is required and explicitly nullable rather than
 * optional, because structured-output JSON schemas are honoured most reliably
 * when there are no optional keys for the model to quietly omit — and because a
 * missing key and a null key should not mean different things to us.
 *
 * Crucially, the model is NOT asked for a total. Totals are arithmetic, and we
 * do that ourselves in `gradeQuestion` so a hallucinated sum can never reach a
 * teacher. See `packages/server/src/grading/validate.ts`.
 */

export const CRITERION_STATUSES = ['correct', 'partial', 'missing', 'incorrect'] as const;
export const FINDING_KINDS = [
  'incorrect', // a substantive error in reasoning or fact
  'missing', // a required point that never appears
  'spelling',
  'grammar',
  'layout', // alignment / overflow / structural presentation problems
  'praise', // something done well; worth showing the student
] as const;

export const ModelCriterionJudgementSchema = z.object({
  criterionId: z.string(),
  /** Marks the model believes are earned. Clamped and re-totalled server-side. */
  awardedMarks: z.number(),
  status: z.enum(CRITERION_STATUSES),
  /**
   * A verbatim span copied out of the student's answer. Verified to actually
   * occur in the answer text before any feedback derived from it is shown.
   * Null is legitimate for a `missing` criterion — there is nothing to quote.
   */
  evidenceQuote: z.string().nullable(),
  reasoning: z.string(),
  /** What the student should have written. Null when the criterion is fully met. */
  correction: z.string().nullable(),
});

export const ModelFindingSchema = z.object({
  /** The criterion this finding explains, or null for a presentation-only note. */
  criterionId: z.string().nullable(),
  kind: z.enum(FINDING_KINDS),
  /** Verbatim student text to underline. Preferred over `region` when possible. */
  quote: z.string().nullable(),
  /**
   * Fallback anchor for things with no text to quote — a mislabelled axis, a
   * component drawn in the wrong place. Normalised 0..1 against the page box.
   * Only consulted when `quote` is null or cannot be located.
   */
  region: z
    .object({
      page: z.number().int().nonnegative(),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .nullable(),
  comment: z.string(),
  correction: z.string().nullable(),
  severity: z.enum(['minor', 'major']),
});

export const ModelQuestionGradingSchema = z.object({
  questionId: z.string(),
  criteria: z.array(ModelCriterionJudgementSchema),
  findings: z.array(ModelFindingSchema),
  summary: z.string(),
  /** The model's own certainty. One input to the confidence score, never the whole of it. */
  selfConfidence: z.number(),
});

export type ModelCriterionJudgement = z.infer<typeof ModelCriterionJudgementSchema>;
export type ModelFinding = z.infer<typeof ModelFindingSchema>;
export type ModelQuestionGrading = z.infer<typeof ModelQuestionGradingSchema>;
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];
export type FindingKind = (typeof FINDING_KINDS)[number];
