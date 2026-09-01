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

export interface GradingModel {
  readonly providerName: string;
  readonly modelName: string;
  gradeQuestion(input: GradeQuestionInput, context: ModelAttemptContext): Promise<ModelResponse>;
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
  if (question.guidance.length === 0) return '  (none provided)';
  return question.guidance.map((line) => `  - ${line}`).join('\n');
}

/** The part of the prompt that varies per question. Sits after the cache breakpoint. */
export function buildQuestionPrompt(input: GradeQuestionInput): string {
  const { question, answerText } = input;

  const diagramNote = question.requiresDiagram
    ? `\nThis question awards marks for a diagram. The attached PDF is the student's complete answer sheet — look at the drawing under "Answer ${question.number}" to judge the diagram criteria. Do not assume the diagram matches what the prose claims; check it.`
    : `\nThe attached PDF is the student's complete answer sheet, in case you need to see the layout of this answer.`;

  return `Mark question ${question.number} (${question.subject}), worth ${question.maxMarks} marks in total.

QUESTION AS SET
${question.prompt}

MARKING RUBRIC — award each of these separately, by id
${formatCriteria(question)}

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
