import crypto from 'node:crypto';
import {
  checkResultInvariants,
  validateRubricArithmetic,
  type Annotation,
  type AuditEvent,
  type GradingResult,
  type IngestedDocument,
  type ModelFinding,
  type QuestionResult,
  type Rubric,
} from '@gradesense/shared';
import { config } from '../config.js';
import { ModelUnavailableError, RubricInvalidError } from '../errors.js';
import { isBlankAnswer, segmentAnswers, type AnswerSegment } from '../ingest/segment.js';
import { anchorQuote, anchorRegion, marginNoteRect } from './anchor.js';
import { combineConfidence, computeConfidence } from './confidence.js';
import { isTransientModelError } from './providers/anthropic.js';
import type { GradingModel } from './model.js';
import {
  blankQuestion,
  ungradedQuestion,
  validateQuestionGrading,
  type ConfidenceDraft,
} from './validate.js';

export interface RunGradingInput {
  rubric: Rubric;
  studentDocument: IngestedDocument;
  /** Original bytes, forwarded to the model so it can see diagrams. */
  studentPdfBytes: Buffer;
  questionPaperDocumentId?: string | null;
  modelAnswerDocumentId?: string | null;
  model: GradingModel;
}

export interface RunGradingOutput {
  result: GradingResult;
  annotations: Annotation[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Marks one paper end to end.
 *
 * Questions are graded independently, which buys three things: the prompt stays
 * focused on one rubric, an unanswered question can skip the model entirely, and
 * a failure on one question does not corrupt the others.
 *
 * The exception to that independence is a model outage. If the grader cannot be
 * reached for even one question after every retry, the whole run fails with a
 * 503 and nothing is written. A half-graded paper sitting in the history, with
 * marks for two questions out of three, is a trap for whoever opens it next —
 * better to fail cleanly and let the teacher press the button again.
 */
export async function runGrading(input: RunGradingInput): Promise<RunGradingOutput> {
  const { rubric, studentDocument, studentPdfBytes, model } = input;

  const rubricProblems = validateRubricArithmetic(rubric);
  if (rubricProblems.length > 0) {
    throw new RubricInvalidError(
      'The marking rubric does not add up, so it cannot be used to mark a paper.',
      rubricProblems,
    );
  }

  const segments = segmentAnswers(studentDocument.pages, rubric.questions);
  const segmentById = new Map(segments.map((segment) => [segment.questionId, segment]));

  const resultId = crypto.randomUUID();
  const pdfBase64 = studentPdfBytes.toString('base64');

  const audit: AuditEvent[] = [];
  const questionResults: QuestionResult[] = [];
  const annotations: Annotation[] = [];

  for (const question of rubric.questions) {
    const segment =
      segmentById.get(question.id) ??
      ({ questionId: question.id, number: question.number, text: '', startPage: 0, approximate: true } satisfies AnswerSegment);

    // Unanswered questions never reach the model. This is both cheaper and more
    // reliable than asking a grader to notice emptiness.
    if (isBlankAnswer(segment, config.grading.blankAnswerMinChars)) {
      const blank = blankQuestion(question);
      questionResults.push(blank.result);
      audit.push(blank.audit);
      continue;
    }

    const graded = await gradeOneQuestion({
      question,
      segment,
      pdfBase64,
      studentDocument,
      model,
    });

    audit.push(...graded.audit);

    if (!graded.validated) {
      questionResults.push(graded.result);
      continue;
    }

    // Place the annotations, then finish the confidence score with what the
    // anchoring actually achieved.
    const placed = buildAnnotations({
      resultId,
      questionId: question.id,
      findings: graded.findings,
      studentDocument,
      startPage: segment.startPage,
      slotOffset: annotations.length,
    });
    annotations.push(...placed.annotations);

    const confidence = computeConfidence({
      ...graded.confidenceDraft,
      unresolvedAnchors: placed.unresolved,
      regionAnchors: placed.regions,
    });

    for (let i = 0; i < placed.unresolved; i += 1) {
      audit.push({
        kind: 'anchor_unresolved',
        questionId: question.id,
        criterionId: null,
        detail: 'An annotation could not be placed on the page and was shown as a margin note.',
        before: null,
        after: null,
      });
    }

    questionResults.push({
      ...graded.result,
      confidence: confidence.value,
      notes: [...graded.result.notes, ...confidence.factors],
    });
  }

  const totalMarks = round(questionResults.reduce((total, question) => total + question.awardedMarks, 0));
  const maxMarks = round(rubric.questions.reduce((total, question) => total + question.maxMarks, 0));

  const confidence = combineConfidence(
    questionResults.map((question) => ({ confidence: question.confidence, maxMarks: question.maxMarks })),
  );

  const { requiresHumanReview, reviewReasons } = decideReview(questionResults, audit, confidence);

  const result: GradingResult = {
    id: resultId,
    createdAt: new Date().toISOString(),
    rubricId: rubric.id,
    studentAnswerDocumentId: studentDocument.id,
    studentAnswerFilename: studentDocument.filename,
    questionPaperDocumentId: input.questionPaperDocumentId ?? null,
    modelAnswerDocumentId: input.modelAnswerDocumentId ?? null,
    provider: model.providerName,
    model: model.modelName,
    totalMarks,
    maxMarks,
    questions: questionResults,
    confidence,
    requiresHumanReview,
    reviewReasons,
    audit,
  };

  // Last line of defence. These are the brief's hard rules; if one is broken the
  // bug is ours, and the paper must not go out looking clean.
  const violations = checkResultInvariants(result);
  if (violations.length > 0) {
    result.requiresHumanReview = true;
    result.reviewReasons = [
      ...result.reviewReasons,
      ...violations.map((violation) => `Internal consistency check failed: ${violation}`),
    ];
    result.confidence = 0;
  }

  return { result, annotations };
}

/* ----------------------------- per-question run ---------------------------- */

interface GradeOneInput {
  question: Rubric['questions'][number];
  segment: AnswerSegment;
  pdfBase64: string;
  studentDocument: IngestedDocument;
  model: GradingModel;
}

type GradeOneOutput =
  | {
      validated: true;
      result: QuestionResult;
      findings: ModelFinding[];
      audit: AuditEvent[];
      confidenceDraft: ConfidenceDraft;
    }
  | { validated: false; result: QuestionResult; audit: AuditEvent[] };

/**
 * One question, with retries.
 *
 * Two different kinds of failure are handled, and conflating them would be a
 * mistake. A transient error (rate limit, 5xx, dropped socket) is worth retrying
 * with backoff, because the same request may well succeed. Output that fails
 * schema validation is not — retrying it unchanged would produce the same
 * garbage, so the model is re-asked with its own output and the validation
 * errors attached.
 */
async function gradeOneQuestion(input: GradeOneInput): Promise<GradeOneOutput> {
  const { question, segment, pdfBase64, studentDocument, model } = input;
  const audit: AuditEvent[] = [];

  const modelInput = {
    question,
    answerText: segment.text,
    pdfBase64,
    pageCount: studentDocument.pageCount,
    startPage: segment.startPage,
    pages: studentDocument.pages,
  };

  let repairAttempts = 0;
  let lastValidationErrors: string[] = [];
  let lastRaw = '';
  let transientFailures = 0;
  let lastTransientError: unknown = null;

  for (let attempt = 1; attempt <= config.grading.maxModelAttempts; attempt += 1) {
    const context =
      repairAttempts > 0 && lastRaw
        ? { repair: { rawResponse: lastRaw, validationErrors: lastValidationErrors } }
        : {};

    let response;
    try {
      response = await model.gradeQuestion(modelInput, context);
    } catch (error) {
      if (!isTransientModelError(error)) throw error;

      transientFailures += 1;
      lastTransientError = error;
      audit.push({
        kind: 'model_retry',
        questionId: question.id,
        criterionId: null,
        detail: `Attempt ${attempt} failed with a transient error: ${errorMessage(error)}`,
        before: null,
        after: null,
      });

      if (attempt < config.grading.maxModelAttempts) {
        // Exponential backoff: 400ms, 800ms, 1600ms...
        await sleep(config.grading.retryBaseDelayMs * 2 ** (attempt - 1));
        continue;
      }
      break;
    }

    lastRaw = response.raw;

    const validation = validateQuestionGrading(response.data, {
      question,
      answerText: segment.text,
      pages: studentDocument.pages,
      repairAttempts,
      approximateSegmentation: segment.approximate,
      markGranularity: config.grading.markGranularity,
    });

    if (validation.ok) {
      if (repairAttempts > 0) {
        audit.push({
          kind: 'malformed_output_repaired',
          questionId: question.id,
          criterionId: null,
          detail: `The grader's first response failed validation and was corrected on re-ask after ${repairAttempts} attempt(s).`,
          before: null,
          after: null,
        });
      }
      return {
        validated: true,
        result: validation.result,
        findings: validation.findings,
        audit: [...audit, ...validation.audit],
        confidenceDraft: validation.confidenceDraft,
      };
    }

    lastValidationErrors = validation.errors;

    if (repairAttempts < config.grading.maxRepairAttempts) {
      repairAttempts += 1;
      continue;
    }

    // Out of repair attempts: record it as ungraded rather than guessing marks.
    const ungraded = ungradedQuestion(
      question,
      `The grader returned output that did not match the required format, even after being re-asked. Validation errors: ${lastValidationErrors
        .slice(0, 4)
        .join('; ')}`,
    );
    return { validated: false, result: ungraded.result, audit: [...audit, ungraded.audit] };
  }

  // Every attempt ended in a transient failure. This is an outage, not a
  // judgement, so it propagates as a 503 and nothing gets persisted.
  throw new ModelUnavailableError(
    `The grading model could not be reached after ${transientFailures} attempt${transientFailures === 1 ? '' : 's'}. No marks were recorded.`,
    transientFailures,
    lastTransientError,
  );
}

/* --------------------------- annotation placement -------------------------- */

interface BuildAnnotationsInput {
  resultId: string;
  questionId: string;
  findings: ModelFinding[];
  studentDocument: IngestedDocument;
  startPage: number;
  slotOffset: number;
}

interface BuildAnnotationsOutput {
  annotations: Annotation[];
  unresolved: number;
  regions: number;
}

/**
 * Turns findings into annotations with real coordinates.
 *
 * Three tiers, tried in order, degrading honestly rather than guessing:
 * a quote located in the text layer, a model-supplied diagram region, or a
 * margin note that makes no claim about position at all.
 */
function buildAnnotations(input: BuildAnnotationsInput): BuildAnnotationsOutput {
  const { resultId, questionId, findings, studentDocument, startPage, slotOffset } = input;
  const now = new Date().toISOString();

  // First pass: resolve every anchor we can.
  const resolved = findings.map((finding) => {
    let anchor = anchorQuote(finding.quote, studentDocument.pages, startPage);

    if (anchor.status === 'unresolved' && finding.region) {
      anchor = anchorRegion(finding.region, studentDocument.pageCount);
    }

    // When a quote wraps across lines it yields one box per line. The widest is
    // used as the primary: it carries most of the quoted text, so the numbered
    // marker sits beside the substance of the match rather than beside a
    // two-word fragment left at the end of a line.
    const ordered = [...anchor.rects].sort((a, b) => b.width - a.width);
    return { finding, anchor, rects: ordered };
  });

  /*
   * Margin notes go on the last page this question actually reached, not the
   * page it started on. An answer that runs over a page break has its later
   * rubric points discussed on the second page, and putting the note back at
   * the start would file it next to unrelated text.
   */
  const touchedPages = resolved.flatMap((entry) => entry.rects.map((rect) => rect.page));
  const marginPage = touchedPages.length > 0 ? Math.max(...touchedPages) : startPage;

  const annotations: Annotation[] = [];
  let unresolved = 0;
  let regions = 0;

  resolved.forEach((entry, index) => {
    const { finding, anchor } = entry;
    let rect = entry.rects[0];
    let extraRects = entry.rects.slice(1);

    if (!rect) {
      rect = marginNoteRect(marginPage, slotOffset + index);
      extraRects = [];
      unresolved += 1;
    } else if (anchor.status === 'region') {
      regions += 1;
    }

    annotations.push({
      id: crypto.randomUUID(),
      resultId,
      questionId,
      criterionId: finding.criterionId,
      kind: finding.kind,
      severity: finding.severity,
      rect,
      extraRects,
      comment: finding.comment,
      correction: finding.correction,
      quote: finding.quote,
      anchorStatus: anchor.status,
      origin: 'ai',
      editedByHuman: false,
      createdAt: now,
      updatedAt: now,
    });
  });

  return { annotations, unresolved, regions };
}

/* ------------------------------- review flag ------------------------------- */

/**
 * Decides whether a human has to look at this paper before the marks are used.
 *
 * The threshold is one trigger among several. Some conditions warrant review
 * regardless of how confident the arithmetic looks: an unanswered question, a
 * question that could not be graded, a mark that had to be clamped, or a quote
 * that could not be verified. Each reason is recorded in plain language, because
 * "needs review" without a reason just moves the problem to the teacher.
 */
function decideReview(
  questions: QuestionResult[],
  audit: AuditEvent[],
  confidence: number,
): { requiresHumanReview: boolean; reviewReasons: string[] } {
  const reasons: string[] = [];

  const threshold = config.grading.confidenceReviewThreshold;

  if (confidence < threshold) {
    reasons.push(
      `Overall confidence is ${(confidence * 100).toFixed(0)}%, below the ${(threshold * 100).toFixed(0)}% threshold for automatic acceptance.`,
    );
  }

  // A single shaky question matters even when the paper's average looks
  // comfortable — the marks for that question are the ones a teacher needs to
  // check, and an average is very good at hiding them.
  const shaky = questions.filter(
    (question) => question.state === 'graded' && question.confidence < threshold,
  );
  for (const question of shaky) {
    reasons.push(
      `Question ${question.number} was marked with only ${(question.confidence * 100).toFixed(0)}% confidence.`,
    );
  }

  const blanks = questions.filter((question) => question.state === 'blank');
  if (blanks.length > 0) {
    reasons.push(
      `${blanks.length} question${blanks.length === 1 ? '' : 's'} appear${blanks.length === 1 ? 's' : ''} unanswered (Q${blanks
        .map((question) => question.number)
        .join(', Q')}). Please confirm before the zero is final.`,
    );
  }

  const ungraded = questions.filter((question) => question.state === 'ungraded');
  if (ungraded.length > 0) {
    reasons.push(
      `${ungraded.length} question${ungraded.length === 1 ? '' : 's'} could not be marked automatically (Q${ungraded
        .map((question) => question.number)
        .join(', Q')}) and need${ungraded.length === 1 ? 's' : ''} marking by hand.`,
    );
  }

  const clamps = audit.filter(
    (event) => event.kind === 'clamped_above_max' || event.kind === 'clamped_below_zero',
  );
  if (clamps.length > 0) {
    reasons.push(
      `${clamps.length} mark${clamps.length === 1 ? '' : 's'} fell outside the permitted range and had to be corrected automatically.`,
    );
  }

  const unverified = audit.filter((event) => event.kind === 'evidence_unverified');
  if (unverified.length > 0) {
    reasons.push(
      `${unverified.length} piece${unverified.length === 1 ? '' : 's'} of cited evidence could not be found in the answer.`,
    );
  }

  const missing = audit.filter((event) => event.kind === 'rubric_criterion_missing');
  if (missing.length > 0) {
    reasons.push(
      `${missing.length} rubric point${missing.length === 1 ? ' was' : 's were'} not marked by the grader and scored zero by default.`,
    );
  }

  return { requiresHumanReview: reasons.length > 0, reviewReasons: reasons };
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
