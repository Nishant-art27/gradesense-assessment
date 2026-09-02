import type { PageText, Question } from '@gradesense/shared';
import type { DocumentChunk } from '../ingest/chunk.js';

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

/** One piece of a question paper or marking scheme, read on its own. */
export interface DocumentChunkInput {
  chunk: DocumentChunk;
  /** Filename, so the prompt can say which document the excerpt is from. */
  documentName: string;
  /**
   * Questions already known from the question paper, so a marking-scheme
   * excerpt is read against the right numbers and totals.
   */
  knownQuestions: Array<{ number: number; maxMarks: number | null }>;
}

/** One piece of a student's answer sheet, to be attributed to questions. */
export interface AnswerChunkInput {
  chunk: DocumentChunk;
  /** The rubric's questions, so content can be matched when headings are missing. */
  questions: Array<{ number: number; prompt: string }>;
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
  /**
   * Reads the questions out of one excerpt of a question paper. With
   * `extractSchemeChunk`, this is how a paper too large for one request is read
   * in full: piece by piece, joined afterwards by question number. Optional, but
   * every provider with a model behind it should offer both.
   */
  extractQuestionPaperChunk?(input: DocumentChunkInput): Promise<ModelResponse>;
  /** Reads the marking for each question out of one excerpt of a marking scheme. */
  extractSchemeChunk?(input: DocumentChunkInput): Promise<ModelResponse>;
  /**
   * Says which questions a piece of an answer sheet is answering. Used only when
   * the sheet has no headings to split on, in place of handing the whole sheet
   * to every question.
   */
  attributeAnswerChunk?(input: AnswerChunkInput): Promise<ModelResponse>;
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

/** How much of the previous response a repair prompt quotes back by default. */
export const REPAIR_EXCERPT_CHARS = 4000;

/**
 * Appended when re-asking after a schema failure, in place of a fresh prompt.
 *
 * `maxExcerptChars` lets a provider with a tight token budget quote less of the
 * bad response back, so the repair attempt itself does not become the request
 * that is too large.
 */
export function buildRepairPrompt(
  rawResponse: string,
  validationErrors: string[],
  maxExcerptChars: number = REPAIR_EXCERPT_CHARS,
): string {
  const excerpt =
    rawResponse.length > maxExcerptChars
      ? `${rawResponse.slice(0, Math.max(0, maxExcerptChars))}\n[… ${rawResponse.length - maxExcerptChars} more characters not shown]`
      : rawResponse;

  return `Your previous response did not match the required schema and could not be used.

Validation errors:
${validationErrors.map((error) => `  - ${error}`).join('\n')}

Your previous response was:
"""
${excerpt}
"""

Send the same marking judgement again, corrected so it satisfies the schema exactly. Do not change your marks unless a validation error requires it. Return only the structured object.`;
}

/* ------------------------ reading a document in pieces ------------------------ */
/*
 * A question paper or marking scheme that does not fit one request is read as a
 * sequence of excerpts, each with its own prompt below. The excerpts are joined
 * afterwards by question number (`rubric/merge.ts`), so every prompt leans on the
 * same two things: use the number as printed, and say when an entry is cut by
 * the excerpt boundary.
 */

export const QUESTION_PAPER_CHUNK_SYSTEM_PROMPT = `You are reading ONE EXCERPT of an examination question paper and transcribing the questions in it into a structured list. Other excerpts are read separately and the results are joined by question number, so getting the numbering and the boundaries right matters more than anything else.

Rules:
- Transcribe each question exactly as printed: every sub-part ((a), (b), (i), (ii)…) and every OR alternative, in full. Never summarise or paraphrase a question.
- Use the question number as printed. Never renumber, and never invent a question that is not in the excerpt.
- Record the marks printed against the question. If the excerpt does not state them, use null — do not guess.
- If the excerpt begins in the middle of a question, transcribe the part you can see and set continuesFromPreviousChunk to true. If a question is cut off at the end of the excerpt, transcribe what is there and set continuesIntoNextChunk to true.
- Ignore general instructions, the cover page, lists of physical constants, page headers and footers.
- If the paper is printed in two languages, transcribe the English text only.
- Set requiresDiagram to true only when the question itself asks for a diagram, ray diagram, graph, circuit or labelled figure.`;

export const SCHEME_CHUNK_SYSTEM_PROMPT = `You are reading ONE EXCERPT of an examination marking scheme and converting the marking for each question into a structured form. Other excerpts are read separately and the results are joined by question number.

Rules:
- Use the question number as printed in the scheme. Never renumber.
- "criteria" are the scheme's value points: one entry per point, each with exactly the marks the scheme places against it. Write ½ as 0.5 and 1½ as 1.5. Keep the scheme's order and wording. Do not merge two points into one, and do not reword a point into something more general.
- When the scheme gives a summary box of marks AND the detailed steps, use the detailed steps as the criteria and copy the summary box into modelAnswer.
- "modelAnswer" is the worked answer, copied as written — equations, values, conclusions. Not a summary.
- "guidance" holds the examiner's instructions verbatim, one per entry: "Award full marks for any other correct method", "Any two reasons", "Alternatively: …". These change how the paper is marked and must not be dropped.
- OR alternatives: a question offering a choice has two complete marking schemes. Put the FIRST alternative's value points in "criteria". Put the second alternative into "guidance" as one entry that begins "OR alternative — if the student attempted the alternative question, mark against these points instead:" followed by its value points and their marks, and copy its worked answer into modelAnswer after a line reading "OR". Never add the two alternatives' marks together.
- "maxMarks" is the question's total as the scheme states it, or null if this excerpt does not say.
- If the excerpt begins in the middle of a question, record the part you can see and set continuesFromPreviousChunk to true. If a question is cut off at the end, set continuesIntoNextChunk to true.
- Never invent a value point or a mark the scheme does not contain.`;

export const ANSWER_CHUNK_SYSTEM_PROMPT = `You are reading ONE EXCERPT of a student's answer sheet, as text extracted from the scanned pages. Your only job is to say which questions the student is answering in it. You are not marking anything.

Rules:
- Use the student's own headings where there are any ("Ans 31", "Q.31", "31.", "Answer to question 3"). Where there is no heading, match the content against the list of questions you are given.
- Report every question that has any part of its answer in this excerpt.
- Set beginsInThisChunk to true only when the opening of the answer is in this excerpt. Then copy the first six to ten words of that answer exactly as they appear here into firstWords, so the exact starting point can be found. Otherwise firstWords is null.
- Never report a question that is not being answered in the excerpt, and never report a number that is not in the list of questions.`;

function describeChunk(chunk: DocumentChunk, documentName: string): string {
  const pages =
    chunk.startPage === chunk.endPage
      ? `page ${chunk.startPage + 1}`
      : `pages ${chunk.startPage + 1}–${chunk.endPage + 1}`;
  const lines = [`Excerpt ${chunk.index + 1} of ${chunk.total} from "${documentName}", ${pages}.`];
  if (chunk.section) lines.push(`Section heading in force: ${chunk.section}`);
  if (chunk.questionNumbers.length > 0) {
    lines.push(`Question headings detected in this excerpt: ${chunk.questionNumbers.join(', ')}`);
  }
  if (chunk.part) {
    lines.push(
      `This excerpt is part ${chunk.part.index + 1} of ${chunk.part.count} of a single question that was too long to send whole.`,
    );
  }
  return lines.join('\n');
}

function describeKnownQuestions(known: DocumentChunkInput['knownQuestions']): string {
  if (known.length === 0) return '';
  const list = known
    .map((entry) => (entry.maxMarks === null ? `${entry.number}` : `${entry.number} (${entry.maxMarks} marks)`))
    .join(', ');
  return `\nThe question paper contains these questions: ${list}. Use these numbers.\n`;
}

export function buildQuestionPaperChunkPrompt(input: DocumentChunkInput): string {
  return `${describeChunk(input.chunk, input.documentName)}

Transcribe every question, or part of a question, whose text appears in this excerpt.

EXCERPT
"""
${input.chunk.text}
"""

Return one entry per question number present. Return an empty list if the excerpt contains no question text.`;
}

export function buildSchemeChunkPrompt(input: DocumentChunkInput): string {
  return `${describeChunk(input.chunk, input.documentName)}
${describeKnownQuestions(input.knownQuestions)}
Convert the marking for every question, or part of a question, that appears in this excerpt.

EXCERPT
"""
${input.chunk.text}
"""

Return one entry per question number present. Return an empty list if the excerpt contains no marking.`;
}

/** Enough of each question for content to be matched when the sheet has no headings. */
const QUESTION_PREVIEW_CHARS = 160;

export function buildAnswerChunkPrompt(input: AnswerChunkInput): string {
  const questions = input.questions
    .map((question) => {
      const preview = question.prompt.replace(/\s+/g, ' ').trim();
      const shown = preview.length > QUESTION_PREVIEW_CHARS ? `${preview.slice(0, QUESTION_PREVIEW_CHARS)}…` : preview;
      return `  - Question ${question.number}: ${shown || '(text not available)'}`;
    })
    .join('\n');

  return `${describeChunk(input.chunk, 'the student answer sheet')}

THE QUESTIONS ON THIS PAPER
${questions}

EXCERPT OF THE STUDENT'S ANSWER SHEET
"""
${input.chunk.text}
"""

Which of the questions is the student answering in this excerpt, and where does each answer begin?`;
}
