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
import { ModelUnavailableError, RequestTooLargeError, RubricInvalidError } from '../errors.js';
import { attributeAnswers } from '../ingest/attribute.js';
import { splitText } from '../ingest/chunk.js';
import { isBlankAnswer, segmentAnswers, type AnswerSegment } from '../ingest/segment.js';
import { anchorQuote, anchorRegion, marginNoteRect } from './anchor.js';
import { combineConfidence, computeConfidence } from './confidence.js';
import { SYSTEM_PROMPT, buildQuestionPrompt, type GradingModel } from './model.js';
import { mergePasses } from './passes.js';
import { asModelFailure, isRateLimitError, isTransientModelError } from './providers/transient.js';
import { estimateTokens, variableAllowance } from './tokens.js';
import {
  blankQuestion,
  ungradedQuestion,
  validateQuestionGrading,
  type ConfidenceDraft,
  type ValidationSuccess,
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
 * a failure on one question does not corrupt the others. Independence is also
 * what keeps each request small: a question's request carries that question's
 * text, its criteria and its answer — never the whole paper, never the whole
 * scheme, never another student's work.
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

  const { segments, segmentNotes } = await locateAnswers(studentDocument, rubric, model);
  const segmentById = new Map(segments.map((segment) => [segment.questionId, segment]));

  /*
   * A scanned sheet has been read by a vision model, or could not be. Either
   * way every consumer downstream is told: the grading prompt reads a transcript
   * differently from a text layer, the confidence score says the marks rest on
   * a reading of handwriting, and a sheet the provider could not read at all
   * must never pass as a paper full of blank answers.
   */
  const transcription = studentDocument.transcription ?? null;
  const transcribed = transcription?.status === 'done';
  if (transcribed) {
    segmentNotes.push(
      `The answer sheet is a scan with no text layer, so its handwriting was read by a vision model (${transcription.model ?? transcription.provider ?? 'unknown'}), legibility rated "${transcription.legibility ?? 'unknown'}"${
        transcription.unclear.length > 0 ? `, with ${transcription.unclear.length} span${transcription.unclear.length === 1 ? '' : 's'} it could not read with confidence` : ''
      }. Marks below were awarded on that transcript; annotations are shown as margin notes.`,
    );
  }

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
      answerSource: transcribed ? 'transcription' : 'text-layer',
      transcriptionNotes: transcribed
        ? { legibility: transcription.legibility, unclear: transcription.unclear }
        : undefined,
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
      transcribed,
      unclearSpans: transcription?.unclear.length ?? 0,
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
      notes: [...graded.result.notes, ...confidence.factors, ...segmentNotes],
    });
  }

  const totalMarks = round(questionResults.reduce((total, question) => total + question.awardedMarks, 0));
  const maxMarks = round(rubric.questions.reduce((total, question) => total + question.maxMarks, 0));

  const confidence = combineConfidence(
    questionResults.map((question) => ({ confidence: question.confidence, maxMarks: question.maxMarks })),
  );

  const { requiresHumanReview, reviewReasons } = decideReview(questionResults, audit, confidence);

  if (transcription && transcription.status !== 'done') {
    reviewReasons.unshift(
      transcription.status === 'unsupported'
        ? `The answer sheet is a scan with no text layer and the ${transcription.provider ?? 'current'} provider cannot read images, so its ${transcription.pages.length} scanned page${transcription.pages.length === 1 ? '' : 's'} could not be read. Questions on those pages were treated as unanswered — these zeros are NOT a judgement of the student's work. Use a vision-capable provider (groq, gemini or anthropic) to mark this sheet.`
        : `The answer sheet is a scan and reading its handwriting ${transcription.status === 'pending' ? 'had not finished' : 'failed'}${transcription.error ? `: ${transcription.error}` : ''}. Questions on the unread pages were treated as unanswered — these zeros are NOT a judgement of the student's work.`,
    );
  }

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
    requiresHumanReview: requiresHumanReview || reviewReasons.length > 0,
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

/* ------------------------------ finding answers ----------------------------- */

/**
 * Works out which text answers which question.
 *
 * The heading search in `segmentAnswers` is exact and free, and it is what runs
 * for any sheet with "Answer 1"-style markers. Its fallback for a sheet without
 * markers hands the entire document to every question — honest, but for a long
 * sheet that is one request per question each carrying the whole paper. So when
 * the fallback fires and the provider can attribute text, the sheet is read in
 * pieces and each piece is assigned to the question it answers. If attribution
 * fails for any reason the fallback stands, and the result is flagged for review
 * exactly as before.
 */
async function locateAnswers(
  studentDocument: IngestedDocument,
  rubric: Rubric,
  model: GradingModel,
): Promise<{ segments: AnswerSegment[]; segmentNotes: string[] }> {
  const segments = segmentAnswers(studentDocument.pages, rubric.questions);

  // Headings missing for every question, or for some: either way a question's
  // answer may be sitting under another question's heading, so the sheet is
  // read to find out — provided there is any text to read.
  const hasText = studentDocument.pages.some((page) => page.text.trim().length > 0);
  const needsAttribution = hasText && segments.some((segment) => segment.approximate);
  if (!needsAttribution || !model.attributeAnswerChunk) return { segments, segmentNotes: [] };

  const attributed = await attributeAnswers({
    pages: studentDocument.pages,
    questions: rubric.questions,
    model,
    chunkTokens: config.tokens.chunkTokens,
    maxAttempts: config.grading.maxModelAttempts,
    retryBaseDelayMs: config.grading.retryBaseDelayMs,
  });
  if (!attributed) return { segments, segmentNotes: [] };

  // A missing heading corrupts its neighbour too — the previous question's
  // heading-based segment runs on into the unheaded answer — so once any
  // heading is missing the model's reading is used for every question, and a
  // heading-based segment is kept only where the model found nothing at all.
  const merged = segments.map((segment) => {
    const found = attributed.segments.find((entry) => entry.questionId === segment.questionId);
    return found && found.text.trim().length > 0 ? found : segment;
  });
  const filled = segments.filter((segment) => segment.approximate).map((segment) => `Q${segment.number}`);

  return {
    segments: merged,
    segmentNotes: [
      `The answer sheet had no recognisable heading for ${filled.join(', ')}, so the grading model read it in ${attributed.requests} piece${attributed.requests === 1 ? '' : 's'} to work out which text answers which question. Check that the right text was marked.`,
    ],
  };
}

/* ----------------------------- per-question run ---------------------------- */

interface GradeOneInput {
  question: Rubric['questions'][number];
  segment: AnswerSegment;
  pdfBase64: string;
  studentDocument: IngestedDocument;
  model: GradingModel;
  answerSource: 'text-layer' | 'transcription';
  transcriptionNotes?: { legibility: 'good' | 'fair' | 'poor' | null; unclear: string[] };
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

/** Below this many tokens a passage is a fragment, and splitting further is pointless. */
const MIN_PASSAGE_TOKENS = 120;
/** Rounds of halving the passage size before giving up on an answer as unsendable. */
const MAX_SHRINK_ROUNDS = 3;

/**
 * One question, sized to fit.
 *
 * The request for a question is the system prompt, the question with its rubric,
 * and the student's answer. The first two are fixed; the answer is what varies,
 * so it is measured against whatever room the fixed parts leave. An answer that
 * fits — nearly all of them — goes in one request. One that does not is split at
 * its sub-parts or paragraphs, each passage is graded with the same prompt, and
 * the passes are merged criterion by criterion (see `passes.ts`). Nothing is
 * shortened or summarised on the way: the model reads every word the student
 * wrote, just not all in one breath.
 *
 * If the provider still refuses a passage as too large — the estimate is an
 * estimate — the passages are halved and tried again. If they cannot be halved
 * further the question is recorded as ungraded with the reason, never silently
 * cut down.
 */
async function gradeOneQuestion(input: GradeOneInput): Promise<GradeOneOutput> {
  const { question, segment, pdfBase64, studentDocument } = input;

  const fixedParts = [
    SYSTEM_PROMPT,
    buildQuestionPrompt({
      question,
      answerText: '',
      pdfBase64: null,
      pageCount: studentDocument.pageCount,
      startPage: segment.startPage,
      pages: [],
      answerSource: input.answerSource,
      transcriptionNotes: input.transcriptionNotes,
    }),
  ];
  let allowance = variableAllowance(fixedParts);

  if (allowance < MIN_PASSAGE_TOKENS) {
    const ungraded = ungradedQuestion(
      question,
      `The rubric for this question is itself too large to send to the grading model within its ${config.tokens.requestLimit}-token limit, leaving no room for the student's answer. Shorten the criteria or model answer, or use a provider with a larger limit.`,
    );
    return { validated: false, result: ungraded.result, audit: [ungraded.audit] };
  }

  let passages = estimateTokens(segment.text) <= allowance ? [segment.text] : splitText(segment.text, allowance);
  const audit: AuditEvent[] = [];

  for (let round = 0; round <= MAX_SHRINK_ROUNDS; round += 1) {
    const passes: ValidationSuccess[] = [];
    let refused: RequestTooLargeError | null = null;

    for (const passage of passages) {
      const outcome = await gradePassage({ ...input, answerText: passage }, pdfBase64);
      audit.push(...outcome.audit);

      if (outcome.kind === 'too_large') {
        refused = outcome.error;
        break;
      }
      if (outcome.kind === 'unvalidated') {
        return { validated: false, result: outcome.result, audit };
      }
      passes.push(outcome.success);
    }

    if (!refused) {
      const merged = mergePasses(question, passes);
      return {
        validated: true,
        result: merged.result,
        findings: merged.findings,
        audit,
        confidenceDraft: merged.confidenceDraft,
      };
    }

    // The provider disagreed with the estimate. Halve and go again.
    allowance = Math.floor(allowance / 2);
    if (allowance < MIN_PASSAGE_TOKENS || round === MAX_SHRINK_ROUNDS) {
      const ungraded = ungradedQuestion(
        question,
        `The answer to this question could not be sent to the grading model within its token limit, even after being split into passages of about ${allowance * 2} tokens. ${refused.message} Nothing was cut from the answer; it needs marking by hand or a provider with a larger limit.`,
      );
      return { validated: false, result: ungraded.result, audit: [...audit, ungraded.audit] };
    }
    passages = splitText(segment.text, allowance);
  }

  // Unreachable: every path through the loop returns.
  throw new Error('gradeOneQuestion fell through its retry loop');
}

type PassageOutcome =
  | { kind: 'validated'; success: ValidationSuccess; audit: AuditEvent[] }
  | { kind: 'unvalidated'; result: QuestionResult; audit: AuditEvent[] }
  | { kind: 'too_large'; error: RequestTooLargeError; audit: AuditEvent[] };

/**
 * One passage of one question, with retries.
 *
 * Three different kinds of failure are handled, and conflating them would be a
 * mistake. A transient error (rate limit, 5xx, dropped socket) is worth retrying
 * with backoff, because the same request may well succeed. Output that fails
 * schema validation is not — retrying it unchanged would produce the same
 * garbage, so the model is re-asked with its own output and the validation
 * errors attached. And a request refused as too large is neither: it is handed
 * back to the caller, which knows how to make it smaller.
 */
async function gradePassage(
  input: GradeOneInput & { answerText: string },
  pdfBase64: string,
): Promise<PassageOutcome> {
  const { question, segment, studentDocument, model, answerText } = input;
  const audit: AuditEvent[] = [];

  const modelInput = {
    question,
    answerText,
    pdfBase64,
    pageCount: studentDocument.pageCount,
    startPage: segment.startPage,
    pages: studentDocument.pages,
    answerSource: input.answerSource,
    transcriptionNotes: input.transcriptionNotes,
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
      if (error instanceof RequestTooLargeError) {
        return { kind: 'too_large', error, audit };
      }

      // A failure retrying cannot fix is reported now, in words rather than
      // in the provider's raw JSON.
      if (!isTransientModelError(error)) throw asModelFailure(error, model.providerName);

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
      answerText,
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
        kind: 'validated',
        success: { ...validation, audit: validation.audit },
        audit: [...audit, ...validation.audit],
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
    return { kind: 'unvalidated', result: ungraded.result, audit: [...audit, ungraded.audit] };
  }

  // Every attempt ended in a transient failure. This is an outage, not a
  // judgement, so it propagates as a 503 and nothing gets persisted.
  throw new ModelUnavailableError(
    isRateLimitError(lastTransientError)
      ? `${model.providerName}'s per-minute token allowance was exhausted, and it was still exhausted after ${transientFailures} attempt${transientFailures === 1 ? '' : 's'}. No marks were recorded — wait a minute and mark the script again.`
      : `The grading model could not be reached after ${transientFailures} attempt${transientFailures === 1 ? '' : 's'}. No marks were recorded.`,
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
      anchor = anchorRegion(finding.region, studentDocument.pages);
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

    // A quote that was found in a transcript has no rectangle: verified text,
    // but a margin note on the page, and labelled as such.
    let anchorStatus = anchor.status;
    if (!rect) {
      rect = marginNoteRect(marginPage, slotOffset + index);
      extraRects = [];
      unresolved += 1;
      anchorStatus = 'unresolved';
    } else if (anchor.status === 'region' || anchor.approximatePosition) {
      // A box estimated from a scanned line is right to within a line or so,
      // which is what "region" already means to the UI and the confidence score.
      regions += 1;
      anchorStatus = 'region';
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
      anchorStatus,
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
