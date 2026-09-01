import {
  ModelQuestionGradingSchema,
  type AuditEvent,
  type CriterionScore,
  type Evidence,
  type ModelFinding,
  type ModelQuestionGrading,
  type PageText,
  type Question,
  type QuestionResult,
} from '@gradesense/shared';
import { anchorQuote } from './anchor.js';
import type { ConfidenceInput } from './confidence.js';

/**
 * Turning whatever the model said into marks we are willing to stand behind.
 *
 * The brief's hard rules are enforced here, in code, rather than being asked for
 * in the prompt:
 *
 *   · no mark exceeds its maximum, and none is negative
 *   · the total is recomputed from the clamped criteria, never taken on trust
 *   · every rubric criterion is accounted for, even one the model forgot
 *   · feedback that cites a quote which is not in the answer is marked
 *     unverified, loses its annotation, and drags confidence down
 *
 * A prompt can ask for all of that. Only code can guarantee it.
 */

/**
 * Everything confidence depends on that is known at validation time. The two
 * anchor counts are missing because annotations have not been placed yet — the
 * pipeline fills those in and computes the final score, so confidence is
 * calculated once, from complete information.
 */
export type ConfidenceDraft = Omit<ConfidenceInput, 'unresolvedAnchors' | 'regionAnchors'>;

export interface ValidationSuccess {
  ok: true;
  /** `confidence` is a placeholder here; the pipeline sets the real value. */
  result: QuestionResult;
  /** Findings whose evidence checked out, ready for anchoring. */
  findings: ModelFinding[];
  audit: AuditEvent[];
  confidenceDraft: ConfidenceDraft;
}

export interface ValidationFailure {
  ok: false;
  errors: string[];
}

export type ValidationOutcome = ValidationSuccess | ValidationFailure;

export interface ValidateOptions {
  question: Question;
  answerText: string;
  pages: PageText[];
  /** How many times the model had already been re-asked before this output. */
  repairAttempts: number;
  approximateSegmentation: boolean;
  markGranularity: number;
}

/** Parses raw model output. Returns readable errors for the repair prompt. */
export function parseModelOutput(raw: unknown): ValidationFailure | { ok: true; value: ModelQuestionGrading } {
  const parsed = ModelQuestionGradingSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };

  const errors = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });

  return { ok: false, errors };
}

function snap(value: number, granularity: number): number {
  if (granularity <= 0) return value;
  const snapped = Math.round(value / granularity) * granularity;
  // Guard against float dust like 2.5000000000000004.
  return Number(snapped.toFixed(4));
}

/**
 * Brings one criterion's mark into range.
 *
 * Both directions are recorded in the audit trail. The above-maximum case is the
 * one the brief calls out explicitly, and it is the reason the total is never
 * taken from the model: a single unclamped 7-out-of-5 would otherwise put a
 * paper over its own maximum.
 */
function clampMark(
  raw: number,
  maxMarks: number,
  granularity: number,
  criterionId: string,
  questionId: string,
): { value: number; audit: AuditEvent | null } {
  if (!Number.isFinite(raw)) {
    return {
      value: 0,
      audit: {
        kind: 'clamped_below_zero',
        questionId,
        criterionId,
        detail: `Awarded marks were not a finite number; recorded as 0.`,
        before: null,
        after: 0,
      },
    };
  }

  if (raw > maxMarks) {
    return {
      value: maxMarks,
      audit: {
        kind: 'clamped_above_max',
        questionId,
        criterionId,
        detail: `Grader awarded ${raw} for a criterion worth ${maxMarks}; reduced to the maximum.`,
        before: raw,
        after: maxMarks,
      },
    };
  }

  if (raw < 0) {
    return {
      value: 0,
      audit: {
        kind: 'clamped_below_zero',
        questionId,
        criterionId,
        detail: `Grader awarded ${raw}, which is negative; raised to 0.`,
        before: raw,
        after: 0,
      },
    };
  }

  return { value: snap(raw, granularity), audit: null };
}

export function validateQuestionGrading(raw: unknown, options: ValidateOptions): ValidationOutcome {
  const parsed = parseModelOutput(raw);
  if (!parsed.ok) return parsed;

  const grading = parsed.value;
  const { question, answerText, pages, markGranularity } = options;

  const audit: AuditEvent[] = [];
  const notes: string[] = [];

  const byCriterionId = new Map(grading.criteria.map((entry) => [entry.criterionId, entry]));

  // Anything the model returned that is not in the rubric is discarded — it
  // cannot carry marks, because marks only exist against rubric criteria.
  for (const judgement of grading.criteria) {
    if (!question.criteria.some((criterion) => criterion.id === judgement.criterionId)) {
      audit.push({
        kind: 'unknown_criterion_ignored',
        questionId: question.id,
        criterionId: judgement.criterionId,
        detail: `Grader returned a judgement for "${judgement.criterionId}", which is not in this question's rubric. Ignored.`,
        before: null,
        after: null,
      });
    }
  }

  let clampEvents = 0;
  let missingCriteria = 0;
  let quotedCriteria = 0;
  let verifiedQuotes = 0;
  let rawTotal = 0;

  const scores: CriterionScore[] = question.criteria.map((criterion) => {
    const judgement = byCriterionId.get(criterion.id);

    // A criterion the model never mentioned scores zero, but loudly. Silently
    // dropping it would make the total disagree with the rubric.
    if (!judgement) {
      missingCriteria += 1;
      audit.push({
        kind: 'rubric_criterion_missing',
        questionId: question.id,
        criterionId: criterion.id,
        detail: `Grader did not return a judgement for "${criterion.id}". Recorded as 0 and flagged for review.`,
        before: null,
        after: 0,
      });
      notes.push(`"${criterion.description}" was not marked by the grader and needs a human decision.`);

      return {
        criterionId: criterion.id,
        description: criterion.description,
        maxMarks: criterion.maxMarks,
        awardedMarks: 0,
        status: 'missing',
        reasoning: 'The grader did not return a judgement for this rubric point.',
        correction: null,
        evidence: null,
      };
    }

    rawTotal += Number.isFinite(judgement.awardedMarks) ? judgement.awardedMarks : 0;

    const clamped = clampMark(
      judgement.awardedMarks,
      criterion.maxMarks,
      markGranularity,
      criterion.id,
      question.id,
    );
    if (clamped.audit) {
      audit.push(clamped.audit);
      clampEvents += 1;
    }

    // Verify the citation against the student's actual answer.
    let evidence: Evidence | null = null;
    if (judgement.evidenceQuote && judgement.evidenceQuote.trim().length > 0) {
      quotedCriteria += 1;
      const anchor = anchorQuote(judgement.evidenceQuote, pages);
      const verified = anchor.status === 'exact' || anchor.status === 'fuzzy';
      if (verified) verifiedQuotes += 1;
      else {
        audit.push({
          kind: 'evidence_unverified',
          questionId: question.id,
          criterionId: criterion.id,
          detail: `The quote cited for "${criterion.id}" does not appear in the student's answer. The mark stands but the citation is shown as unverified and its annotation was dropped.`,
          before: null,
          after: null,
        });
        notes.push(
          `The evidence quoted for "${criterion.description}" could not be found in the answer, so this judgement is unverified.`,
        );
      }

      evidence = {
        quote: judgement.evidenceQuote,
        matchedText: anchor.matchedText,
        verified,
        similarity: anchor.similarity,
        rects: anchor.rects,
      };
    }

    return {
      criterionId: criterion.id,
      description: criterion.description,
      maxMarks: criterion.maxMarks,
      awardedMarks: clamped.value,
      status: judgement.status,
      reasoning: judgement.reasoning,
      correction: judgement.correction,
      evidence,
    };
  });

  const awardedMarks = snap(
    scores.reduce((total, score) => total + score.awardedMarks, 0),
    markGranularity,
  );

  // The total is always derived. Recording the discrepancy makes the correction
  // visible instead of silent.
  if (Math.abs(rawTotal - awardedMarks) > 1e-9) {
    audit.push({
      kind: 'total_recomputed',
      questionId: question.id,
      criterionId: null,
      detail: `Grader's marks summed to ${snap(rawTotal, 0.0001)}; the total was recomputed from the corrected criteria.`,
      before: snap(rawTotal, 0.0001),
      after: awardedMarks,
    });
  }

  /**
   * Findings are only kept when their quote can be located. An annotation drawn
   * from a quote that is not in the answer would point at the wrong words, which
   * is worse for a teacher than no annotation at all.
   */
  const keptFindings: ModelFinding[] = [];
  for (const finding of grading.findings) {
    if (finding.quote && finding.quote.trim().length > 0) {
      const anchor = anchorQuote(finding.quote, pages);
      if (anchor.status === 'unresolved') {
        audit.push({
          kind: 'evidence_unverified',
          questionId: question.id,
          criterionId: finding.criterionId,
          detail: `An annotation quoted "${truncate(finding.quote, 60)}", which is not in the answer. The annotation was dropped.`,
          before: null,
          after: null,
        });
        continue;
      }
    }
    keptFindings.push(finding);
  }

  const confidenceDraft: ConfidenceDraft = {
    selfConfidence: grading.selfConfidence,
    quotedCriteria,
    verifiedQuotes,
    clampEvents,
    repairAttempts: options.repairAttempts,
    missingCriteria,
    answerChars: answerText.length,
    approximateSegmentation: options.approximateSegmentation,
  };

  const result: QuestionResult = {
    questionId: question.id,
    number: question.number,
    subject: question.subject,
    state: 'graded',
    awardedMarks,
    maxMarks: question.maxMarks,
    summary: grading.summary,
    criteria: scores,
    // Replaced by the pipeline once annotation anchoring is known.
    confidence: 0,
    notes,
  };

  return { ok: true, result, findings: keptFindings, audit, confidenceDraft };
}

/**
 * The result recorded for a question the model could not be made to grade.
 *
 * Zero marks keep the paper's arithmetic consistent, but the `ungraded` state
 * and the review flag exist so nobody mistakes this for a real zero. The
 * distinction is the whole point: "the student earned nothing" and "we could not
 * mark this" must never look the same on a report.
 */
export function ungradedQuestion(question: Question, reason: string): { result: QuestionResult; audit: AuditEvent } {
  return {
    result: {
      questionId: question.id,
      number: question.number,
      subject: question.subject,
      state: 'ungraded',
      awardedMarks: 0,
      maxMarks: question.maxMarks,
      summary: 'This question could not be marked automatically and needs a human examiner.',
      criteria: question.criteria.map((criterion) => ({
        criterionId: criterion.id,
        description: criterion.description,
        maxMarks: criterion.maxMarks,
        awardedMarks: 0,
        status: 'missing' as const,
        reasoning: 'Not marked — the grader did not return usable output for this question.',
        correction: null,
        evidence: null,
      })),
      confidence: 0,
      notes: [reason, 'Recorded as 0 so the paper total stays consistent, but this is not a judgement of the answer.'],
    },
    audit: {
      kind: 'malformed_output_unrecoverable',
      questionId: question.id,
      criterionId: null,
      detail: reason,
      before: null,
      after: null,
    },
  };
}

/** The result recorded for a question detected as unanswered. */
export function blankQuestion(question: Question): { result: QuestionResult; audit: AuditEvent } {
  return {
    result: {
      questionId: question.id,
      number: question.number,
      subject: question.subject,
      state: 'blank',
      awardedMarks: 0,
      maxMarks: question.maxMarks,
      summary: 'No answer was written for this question.',
      criteria: question.criteria.map((criterion) => ({
        criterionId: criterion.id,
        description: criterion.description,
        maxMarks: criterion.maxMarks,
        awardedMarks: 0,
        status: 'missing' as const,
        reasoning: 'Nothing was written for this question, so no marks could be awarded.',
        correction: null,
        evidence: null,
      })),
      // High but not total: we are confident the text is empty, not that the
      // student drew nothing. A human confirms before a zero is final.
      confidence: 0.9,
      notes: [
        'Detected as unanswered from the answer sheet text, without consulting the grading model.',
        'If the student answered with only a diagram, that would not be picked up here — please confirm.',
      ],
    },
    audit: {
      kind: 'blank_answer_detected',
      questionId: question.id,
      criterionId: null,
      detail: 'No answer text found for this question. Scored 0 without calling the grading model.',
      before: null,
      after: 0,
    },
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
