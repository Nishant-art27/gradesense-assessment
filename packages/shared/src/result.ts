import { z } from 'zod';
import { CRITERION_STATUSES, FINDING_KINDS } from './model-output.js';

/** A rectangle in normalised page space (0..1), so it survives zoom and re-render. */
export const RectSchema = z.object({
  page: z.number().int().nonnegative(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});
export type Rect = z.infer<typeof RectSchema>;

/**
 * How much we trust an annotation's position.
 *
 * `exact`  — the quote was found verbatim in the PDF text layer.
 * `fuzzy`  — matched after normalisation/edit-distance (typo-tolerant).
 * `region` — the model pointed at an area of the page image; approximate.
 * `unresolved` — could not be placed. Shown as a margin note, never guessed.
 */
export const ANCHOR_STATUSES = ['exact', 'fuzzy', 'region', 'unresolved'] as const;
export type AnchorStatus = (typeof ANCHOR_STATUSES)[number];

export const EvidenceSchema = z.object({
  /** The quote as the model returned it. */
  quote: z.string(),
  /** The span actually located in the document, which may differ under fuzzy match. */
  matchedText: z.string().nullable(),
  /** Whether this quote was found in the student's answer at all. */
  verified: z.boolean(),
  similarity: z.number().min(0).max(1),
  rects: z.array(RectSchema),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const CriterionScoreSchema = z.object({
  criterionId: z.string(),
  description: z.string(),
  maxMarks: z.number(),
  awardedMarks: z.number(),
  status: z.enum(CRITERION_STATUSES),
  reasoning: z.string(),
  correction: z.string().nullable(),
  evidence: EvidenceSchema.nullable(),
});
export type CriterionScore = z.infer<typeof CriterionScoreSchema>;

/**
 * `graded`   — normal path.
 * `blank`    — detected as empty before any model call; zero marks, not a judgement.
 * `ungraded` — the model could not be made to produce valid output. Zero marks are
 *              recorded so totals stay consistent, but the result is flagged so no
 *              one mistakes it for a real zero.
 */
export const QUESTION_STATES = ['graded', 'blank', 'ungraded'] as const;
export type QuestionState = (typeof QUESTION_STATES)[number];

export const QuestionResultSchema = z.object({
  questionId: z.string(),
  number: z.number().int(),
  subject: z.string(),
  state: z.enum(QUESTION_STATES),
  awardedMarks: z.number(),
  maxMarks: z.number(),
  summary: z.string(),
  criteria: z.array(CriterionScoreSchema),
  confidence: z.number().min(0).max(1),
  notes: z.array(z.string()),
});
export type QuestionResult = z.infer<typeof QuestionResultSchema>;

export const ANNOTATION_ORIGINS = ['ai', 'human'] as const;
export type AnnotationOrigin = (typeof ANNOTATION_ORIGINS)[number];

/**
 * Annotations live in their own collection, keyed by result id, and are mutable
 * without touching the grading result. That separation is what makes "move,
 * change or delete an annotation without grading the paper again" true rather
 * than merely claimed.
 */
export const AnnotationSchema = z.object({
  id: z.string(),
  resultId: z.string(),
  questionId: z.string().nullable(),
  criterionId: z.string().nullable(),
  kind: z.enum(FINDING_KINDS),
  severity: z.enum(['minor', 'major']),
  rect: RectSchema,
  /** Additional boxes when a quote wraps across lines. */
  extraRects: z.array(RectSchema),
  comment: z.string(),
  correction: z.string().nullable(),
  quote: z.string().nullable(),
  anchorStatus: z.enum(ANCHOR_STATUSES),
  origin: z.enum(ANNOTATION_ORIGINS),
  /** Set once a human has moved or retyped it, so the UI can show provenance. */
  editedByHuman: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

/** Machine-checkable record of every correction the pipeline applied to model output. */
export const AUDIT_KINDS = [
  'clamped_above_max',
  'clamped_below_zero',
  'total_recomputed',
  'evidence_unverified',
  'malformed_output_repaired',
  'malformed_output_unrecoverable',
  'blank_answer_detected',
  'anchor_unresolved',
  'model_retry',
  'rubric_criterion_missing',
  'unknown_criterion_ignored',
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export const AuditEventSchema = z.object({
  kind: z.enum(AUDIT_KINDS),
  questionId: z.string().nullable(),
  criterionId: z.string().nullable(),
  detail: z.string(),
  /** Present on numeric corrections, e.g. a 7 that was clamped to 5. */
  before: z.number().nullable(),
  after: z.number().nullable(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const GradingResultSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  rubricId: z.string(),
  studentAnswerDocumentId: z.string(),
  studentAnswerFilename: z.string(),
  questionPaperDocumentId: z.string().nullable(),
  modelAnswerDocumentId: z.string().nullable(),
  provider: z.string(),
  model: z.string(),

  totalMarks: z.number(),
  maxMarks: z.number(),

  questions: z.array(QuestionResultSchema),

  confidence: z.number().min(0).max(1),
  requiresHumanReview: z.boolean(),
  /** Human-readable reasons behind the review flag. Empty when not flagged. */
  reviewReasons: z.array(z.string()),
  audit: z.array(AuditEventSchema),
});
export type GradingResult = z.infer<typeof GradingResultSchema>;

/** Trimmed shape for the history list. */
export const GradingSummarySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  studentAnswerFilename: z.string(),
  totalMarks: z.number(),
  maxMarks: z.number(),
  confidence: z.number(),
  requiresHumanReview: z.boolean(),
  annotationCount: z.number().int(),
});
export type GradingSummary = z.infer<typeof GradingSummarySchema>;

/**
 * The invariants the brief states as hard rules. Checked after every grading run
 * and asserted in the test suite. Returning a list (rather than throwing) lets
 * the caller attach violations to the audit trail.
 */
export function checkResultInvariants(result: GradingResult): string[] {
  const violations: string[] = [];
  const round = (n: number) => Math.round(n * 1e6) / 1e6;

  for (const question of result.questions) {
    const criteriaSum = round(question.criteria.reduce((acc, c) => acc + c.awardedMarks, 0));
    if (criteriaSum !== round(question.awardedMarks)) {
      violations.push(
        `Q${question.number}: awarded ${question.awardedMarks} but criteria sum to ${criteriaSum}.`,
      );
    }
    if (question.awardedMarks > question.maxMarks) {
      violations.push(
        `Q${question.number}: awarded ${question.awardedMarks} exceeds maximum ${question.maxMarks}.`,
      );
    }
    if (question.awardedMarks < 0) {
      violations.push(`Q${question.number}: awarded ${question.awardedMarks} is negative.`);
    }
    for (const criterion of question.criteria) {
      if (criterion.awardedMarks > criterion.maxMarks) {
        violations.push(
          `Q${question.number}/${criterion.criterionId}: awarded ${criterion.awardedMarks} exceeds ${criterion.maxMarks}.`,
        );
      }
      if (criterion.awardedMarks < 0) {
        violations.push(`Q${question.number}/${criterion.criterionId}: negative marks.`);
      }
    }
  }

  const questionSum = round(result.questions.reduce((acc, q) => acc + q.awardedMarks, 0));
  if (questionSum !== round(result.totalMarks)) {
    violations.push(`Total ${result.totalMarks} does not equal the sum of questions ${questionSum}.`);
  }
  if (result.totalMarks > result.maxMarks) {
    violations.push(`Total ${result.totalMarks} exceeds paper maximum ${result.maxMarks}.`);
  }

  return violations;
}
