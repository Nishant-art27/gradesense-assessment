import type { PageText, Question } from '@gradesense/shared';

/**
 * The seam between the grading pipeline and whatever is producing judgements.
 *
 * Providers return *unvalidated* output on purpose. Every correctness rule the
 * brief states — marks within range, totals that add up, feedback backed by a
 * real quote — is enforced in `validate.ts` against whatever comes back. If
 * providers validated their own output, a mock could be well-behaved in ways the
 * real model is not, and the tests would be proving the wrong thing.
 */

export interface GradeQuestionInput {
  question: Question;
  /** The student's answer to this question alone. */
  answerText: string;
  /** Full answer sheet as base64 PDF, so the model can see diagrams and layout. */
  pdfBase64: string | null;
  pageCount: number;
  /** Page this answer starts on. Used to place region findings sensibly. */
  startPage: number;
  /**
   * The document's text layout. A real vision model does not need this — it can
   * see the page. The mock uses it to locate a diagram from the position of its
   * caption and labels rather than from hardcoded coordinates.
   */
  pages: PageText[];
}

export interface ModelAttemptContext {
  /** Present when re-asking after output failed schema validation. */
  repair?: {
    rawResponse: string;
    validationErrors: string[];
  };
}

export interface ModelResponse {
  /** Parsed JSON when the provider managed it, otherwise null. */
  data: unknown;
  /** Raw text, kept for the repair prompt and the audit trail. */
  raw: string;
}

export interface RubricExtractionInput {
  modelAnswerText: string;
  modelAnswerPdfBase64: string | null;
  questionPaperText: string | null;
}

export interface CriteriaInferenceInput {
  systemPrompt: string;
  prompt: string;
  schema: Record<string, unknown>;
}

export interface GradingModel {
  readonly providerName: string;
  readonly modelName: string;
  gradeQuestion(input: GradeQuestionInput, context: ModelAttemptContext): Promise<ModelResponse>;
  /**
   * Reads a rubric out of a marking scheme the structural parser could not
   * handle. Optional: the deterministic parser covers the common layouts, and a
   * provider with no model behind it has nothing to fall back to.
   */
  extractRubric?(input: RubricExtractionInput): Promise<ModelResponse>;
  /**
   * Derives criteria for a question whose scheme defined none. Optional: the
   * deterministic provider has nothing to infer with, and says so rather than
   * guessing.
   */
  inferCriteria?(input: CriteriaInferenceInput): Promise<ModelResponse>;
}

/** System prompt for rubric extraction. Separate job, separate instructions. */
export const RUBRIC_SYSTEM_PROMPT = `You are reading an examination marking scheme and converting it into a structured rubric.

Rules:
- Transcribe what the scheme says. Do not invent criteria, do not merge two criteria into one, and do not reword a criterion into something more general.
- Every criterion's marks must be exactly what the scheme states. A question's total must equal the sum of its criteria.
- Copy the model answer prose for each question as written; it is used as subject reference when marking.
- Capture any grading guidance verbatim as separate points — rules such as "a student may reach the opposite conclusion and still receive full marks" change how the paper is marked and must not be dropped.
- Set requiresDiagram to true when a question awards marks for a diagram, graph or chart.
- Use the question text from the question paper where it is supplied.`;

export function buildRubricPrompt(input: RubricExtractionInput): string {
  return `Convert this marking scheme into a structured rubric.

${input.questionPaperText ? `QUESTION PAPER\n"""\n${input.questionPaperText}\n"""\n` : ''}
MARKING SCHEME
"""
${input.modelAnswerText}
"""

Return one entry per question, each with its criteria and the marks the scheme assigns to them.`;
}

/**
 * Stable across every request, so it sits in front of the prompt-cache
 * breakpoint. Nothing in here varies by question.
 */
export const SYSTEM_PROMPT = `You are an experienced school examiner marking one question on a candidate's answer sheet. You are careful, fair, and you show your working.

How to mark:
- Award marks criterion by criterion, using exactly the criterion ids you are given. Never invent a criterion id and never omit one.
- Never award more than a criterion's stated maximum, and never award less than zero. Partial credit is allowed where the marking guidance permits it.
- Mark the quality of the student's reasoning, NOT its similarity to the model answer. A student who argues the opposite case, or uses different wording, or lays a diagram out differently, earns full marks when the reasoning and the relationships are sound. Treat the model answer as one acceptable answer among many.
- Apply the question's marking guidance literally. It tells you which differences are acceptable and which are substantive errors.
- Judge spelling, grammar and presentation only where a criterion actually asks for it. An OCR-style misspelling of a technical word is not a subject-matter error: if the meaning is clear, give the content credit and raise the spelling separately as a finding.

Evidence rules — these are strict:
- Every judgement you make about what the student wrote must quote the student verbatim in "evidenceQuote". Copy the characters exactly as they appear, including any misspellings. Do not paraphrase, do not tidy, do not translate.
- Quote enough to be unambiguous, ideally a full clause, and at most about 25 words.
- If a criterion is unmet because the student never addressed it, set "evidenceQuote" to null. Do not quote unrelated text to fill the field.

Findings drive the annotations a teacher sees drawn on the page:
- Raise one finding for each specific problem worth marking on the paper, and use "quote" to give the exact student text it sits on.
- Use "region" ONLY when there is genuinely no text to quote, such as a mislabelled axis or a component drawn in the wrong place in a diagram. Give it as fractions of the page: x and y are the top-left corner, 0,0 is the top-left of the page, 1,1 is the bottom-right.
- Choose "kind" honestly: "incorrect" for wrong reasoning, "missing" for an omission, "spelling" or "grammar" for surface errors, "layout" for alignment and presentation problems, "praise" for something notably well done.
- "correction" is what the student should have written. Make it specific enough to learn from.

Confidence:
- "selfConfidence" is your genuine certainty about this question's marks, from 0 to 1. Use a low value when the answer is ambiguous, hard to read, or when you are unsure whether a diagram shows what the student claims. Saying you are unsure is always better than guessing confidently.`;

function formatCriteria(question: Question): string {
  return question.criteria
    .map((criterion) => `  - id "${criterion.id}" (max ${criterion.maxMarks} marks): ${criterion.description}`)
    .join('\n');
}

function formatGuidance(question: Question): string {
  if (question.guidance.length === 0) {
    return '  (the marking scheme gave no guidance for this question — apply the criteria above on their own merits, using ordinary examining judgement)';
  }
  return question.guidance.map((line) => `  - ${line}`).join('\n');
}

/**
 * Tells the model whose standard it is applying.
 *
 * Inferred criteria are not the instructor's, and the model should not treat
 * them with the same authority — the wording may be imperfect, so it is asked to
 * mark the substance rather than the letter. Presenting them as the teacher's
 * rules would make the grading falsely confident.
 */
function formatCriteriaProvenance(question: Question): string {
  if (question.criteriaSource === 'instructor') {
    return 'These criteria were set by the instructor. Apply them exactly as written; they take priority over your own view of what the question deserves.';
  }
  return 'NOTE: the marking scheme provided no criteria for this question, so the criteria above were inferred from the model answer. They are a reasonable reading, not the instructor\'s own words — mark the substance they describe rather than their exact phrasing, and stay within the stated marks.';
}

/** The part of the prompt that varies per question. Sits after the cache breakpoint. */
export function buildQuestionPrompt(input: GradeQuestionInput): string {
  const { question, answerText } = input;
  const seesPage = input.pdfBase64 !== null;

  /*
   * What the model can actually look at, said plainly.
   *
   * Not every provider can be handed the answer sheet: Groq takes text only.
   * Telling a model that a PDF is attached when none is invites it to describe a
   * drawing it cannot see and award marks for it — a confident, unfalsifiable
   * wrong mark, which is the failure this whole pipeline exists to prevent. So
   * the note follows what was really sent.
   */
  const diagramNote = question.requiresDiagram
    ? seesPage
      ? `\nThis question awards marks for a diagram. The attached PDF is the student's complete answer sheet — look at the drawing under "Answer ${question.number}" to judge the diagram criteria. Do not assume the diagram matches what the prose claims; check it.`
      : `\nThis question awards marks for a diagram, and you CANNOT see it: you have only the text extracted from the answer sheet, which includes the drawing's labels but not the drawing. Judge the diagram criteria only from what the text and labels actually establish. Where the drawing itself would settle it, say so in your reasoning, mark the criterion on the evidence you do have, and give a low selfConfidence. Never describe a drawing you have not seen.`
    : seesPage
      ? `\nThe attached PDF is the student's complete answer sheet, in case you need to see the layout of this answer.`
      : `\nYou have the text extracted from the student's answer sheet, not the sheet itself, so its layout is not visible to you.`;

  return `Mark question ${question.number} (${question.subject}), worth ${question.maxMarks} marks in total.

QUESTION AS SET
${question.prompt}

MARKING RUBRIC — award each of these separately, by id
${formatCriteria(question)}
${formatCriteriaProvenance(question)}

MARKING GUIDANCE FOR THIS QUESTION — follow it exactly
${formatGuidance(question)}

MODEL ANSWER — one acceptable answer, provided as subject reference. Do not mark by similarity to it.
${question.modelAnswer}

THE STUDENT'S ANSWER TO QUESTION ${question.number} — quote from this text only
"""
${answerText.length > 0 ? answerText : '(the student wrote nothing for this question)'}
"""
${diagramNote}

Return one judgement for every criterion id listed above, plus findings for the problems worth drawing on the page.`;
}

/** Appended when re-asking after a schema failure, in place of a fresh prompt. */
export function buildRepairPrompt(rawResponse: string, validationErrors: string[]): string {
  return `Your previous response did not match the required schema and could not be used.

Validation errors:
${validationErrors.map((error) => `  - ${error}`).join('\n')}

Your previous response was:
"""
${rawResponse.slice(0, 4000)}
"""

Send the same marking judgement again, corrected so it satisfies the schema exactly. Do not change your marks unless a validation error requires it. Return only the structured object.`;
}
