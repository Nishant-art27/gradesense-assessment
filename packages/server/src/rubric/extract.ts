import crypto from 'node:crypto';
import {
  RubricSchema,
  validateRubricArithmetic,
  type DraftQuestion,
  type DraftRubric,
  type IngestedDocument,
  type Rubric,
} from '@gradesense/shared';
import type { z } from 'zod';
import { config } from '../config.js';
import { ModelUnavailableError, RequestTooLargeError, RubricInvalidError } from '../errors.js';
import type { GradingModel, ModelResponse } from '../grading/model.js';
import { asModelFailure, isTransientModelError } from '../grading/providers/transient.js';
import { chunkDocument, splitChunk, type DocumentChunk } from '../ingest/chunk.js';
import { buildRubric } from './parse-scheme.js';
import { inferCriteria } from './infer-criteria.js';
import {
  QuestionPaperChunkOutputSchema,
  SchemeChunkOutputSchema,
  joinQuestions,
  mergeQuestionPaperParts,
  mergeSchemeParts,
  type QuestionPaperPart,
  type SchemePart,
  type Sourced,
} from './merge.js';

/**
 * Turning an uploaded marking scheme into a rubric.
 *
 * Three routes, tried in order:
 *
 *  1. **Structural parsing.** Marking schemes are laid out consistently enough
 *     to read exactly. When that works it is free, instant, deterministic and
 *     not capable of inventing a criterion that was never there.
 *  2. **The model, one excerpt at a time.** For a scheme laid out in some way
 *     the parser does not recognise. The question paper and the scheme are each
 *     split into pieces that fit one request, each piece is read on its own,
 *     and the pieces are joined by question number. No request ever carries a
 *     whole document, let alone two, and nothing is summarised on the way.
 *  3. **The model, in one request.** Only for a provider that offers no
 *     chunk-level reading. Kept for compatibility; every shipped provider
 *     offers route 2.
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

  // 2. Read it in pieces.
  if (model.extractSchemeChunk) {
    const staged = await stagedExtraction({ modelAnswer, questionPaper, model, id, title });
    const filled = await fillMissingCriteria(staged.rubric, model);
    return finalise(filled.rubric, 'model', [
      ...parsed.warnings,
      ...staged.warnings,
      ...filled.warnings,
      'This rubric was read by the language model rather than parsed directly. Check it carefully.',
    ]);
  }

  // 3. One request, for a provider that can do nothing else.
  if (!model.extractRubric) {
    throw new RubricInvalidError(
      'The marking scheme could not be read automatically, and the current grading provider cannot extract one.',
      [
        ...parsed.warnings,
        'Set MODEL_PROVIDER to groq, gemini or anthropic to have a model read a scheme this parser does not recognise.',
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

/* ------------------------------ staged route ------------------------------ */

interface StagedInput {
  modelAnswer: IngestedDocument;
  questionPaper: IngestedDocument | null;
  model: GradingModel;
  id: string;
  title: string;
}

interface StagedOutcome {
  rubric: DraftRubric;
  warnings: string[];
}

/**
 * Question paper first, then the scheme, then the join.
 *
 * Reading the paper first is not just for its text: the question numbers and
 * marks it yields are handed to every scheme excerpt, so a scheme that prints a
 * bare "31" in a column is read against the right question, and the chunker
 * knows which bare numbers are headings. Requests are sequential by design —
 * the provider's rate limiter paces them, and a burst of chunk reads would
 * defeat the point of chunking.
 */
async function stagedExtraction(input: StagedInput): Promise<StagedOutcome> {
  const { modelAnswer, questionPaper, model } = input;
  const warnings: string[] = [];
  const chunkTokens = config.tokens.chunkTokens;

  // Question paper.
  const paperParts: Array<Sourced<QuestionPaperPart>> = [];
  let paperChunkCount = 0;
  if (questionPaper && model.extractQuestionPaperChunk) {
    const chunks = chunkDocument(questionPaper.pages, { maxTokens: chunkTokens });
    paperChunkCount = chunks.length;
    for (const chunk of chunks) {
      const results = await readChunk({
        chunk,
        read: (piece) =>
          model.extractQuestionPaperChunk!({ chunk: piece, documentName: questionPaper.filename, knownQuestions: [] }),
        schema: QuestionPaperChunkOutputSchema,
        what: 'question paper',
        model,
      });
      for (const result of results) {
        paperParts.push(...result.value.questions.map((entry) => ({ chunkIndex: result.chunkIndex, entry })));
      }
    }
  }
  const paper = mergeQuestionPaperParts(paperParts);

  const knownQuestions = [...paper.values()]
    .sort((a, b) => a.number - b.number)
    .map((question) => ({ number: question.number, maxMarks: question.maxMarks }));

  // Marking scheme.
  const schemeParts: Array<Sourced<SchemePart>> = [];
  const schemeChunks = chunkDocument(modelAnswer.pages, {
    maxTokens: chunkTokens,
    expectedNumbers: knownQuestions.length > 0 ? knownQuestions.map((question) => question.number) : undefined,
  });
  for (const chunk of schemeChunks) {
    const results = await readChunk({
      chunk,
      read: (piece) =>
        model.extractSchemeChunk!({ chunk: piece, documentName: modelAnswer.filename, knownQuestions }),
      schema: SchemeChunkOutputSchema,
      what: 'marking scheme',
      model,
    });
    for (const result of results) {
      schemeParts.push(...result.value.questions.map((entry) => ({ chunkIndex: result.chunkIndex, entry })));
    }
  }
  const scheme = mergeSchemeParts(schemeParts);

  // Join by question number.
  const subject = deriveSubject(questionPaper, modelAnswer);
  const joined = joinQuestions(paper, scheme, subject);
  warnings.push(...joined.warnings);

  if (joined.questions.length === 0) {
    throw new RubricInvalidError('No questions could be read from the marking scheme.', [
      ...warnings,
      `The marking scheme was read in ${schemeChunks.length} piece${schemeChunks.length === 1 ? '' : 's'} and none of them yielded a question with marks.`,
    ]);
  }

  const questions: DraftQuestion[] = joined.questions.map((question) => ({
    id: `q${question.number}`,
    number: question.number,
    subject: question.subject,
    prompt: question.prompt,
    maxMarks: question.maxMarks,
    modelAnswer: question.modelAnswer,
    guidance: question.guidance,
    requiresDiagram: question.requiresDiagram,
    criteriaSource: 'instructor',
    criteria: question.criteria.map((criterion, index) => ({
      id: `q${question.number}c${index + 1}`,
      description: criterion.description,
      maxMarks: criterion.maxMarks,
    })),
  }));

  warnings.unshift(
    `Read in pieces: ${paperChunkCount} from the question paper and ${schemeChunks.length} from the marking scheme, joined by question number into ${questions.length} question${questions.length === 1 ? '' : 's'} (Q${questions.map((q) => q.number).join(', Q')}).`,
  );

  return {
    rubric: {
      id: input.id,
      title: input.title,
      totalMarks: questions.reduce((total, question) => total + question.maxMarks, 0),
      questions,
    },
    warnings,
  };
}

interface ReadChunkInput<T> {
  chunk: DocumentChunk;
  read: (chunk: DocumentChunk) => Promise<ModelResponse>;
  schema: z.ZodType<T>;
  what: string;
  model: GradingModel;
  depth?: number;
}

/** Deeper than this and the pieces are lines, so splitting again gains nothing. */
const MAX_SPLIT_DEPTH = 4;

/**
 * Reads one excerpt, splitting it and reading the halves when the provider
 * refuses it as too large. Transient failures are retried with backoff; a
 * refused request is not retried unchanged, because it would be refused again.
 */
async function readChunk<T>(input: ReadChunkInput<T>): Promise<Array<{ chunkIndex: number; value: T }>> {
  const { chunk, read, schema, what, model } = input;
  const depth = input.depth ?? 0;

  let response: ModelResponse;
  try {
    response = await withRetries(() => read(chunk), model);
  } catch (error) {
    if (error instanceof RequestTooLargeError) {
      const smaller = depth < MAX_SPLIT_DEPTH ? splitChunk(chunk, Math.max(150, Math.floor(chunk.estimatedTokens / 2))) : [chunk];
      if (smaller.length < 2) {
        throw new RubricInvalidError(
          `Part of the ${what} (pages ${chunk.startPage + 1}–${chunk.endPage + 1}) is too large to send to the model even on its own, so the rubric could not be read.`,
          [error.message, 'Raise MODEL_REQUEST_TOKEN_LIMIT if your provider tier allows more, or split the document.'],
        );
      }
      const out: Array<{ chunkIndex: number; value: T }> = [];
      for (const piece of smaller) {
        out.push(...(await readChunk({ ...input, chunk: piece, depth: depth + 1 })));
      }
      return out;
    }
    throw asModelFailure(error, model.providerName);
  }

  const parsed = schema.safeParse(response.data);
  if (!parsed.success) {
    throw new RubricInvalidError(
      `The model's reading of the ${what} (pages ${chunk.startPage + 1}–${chunk.endPage + 1}) did not match the expected shape.`,
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  return [{ chunkIndex: chunk.index, value: parsed.data }];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withRetries<T>(task: () => Promise<T>, model: GradingModel): Promise<T> {
  let failures = 0;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= config.grading.maxModelAttempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (!isTransientModelError(error)) throw error;
      failures += 1;
      lastError = error;
      if (attempt < config.grading.maxModelAttempts) {
        await sleep(config.grading.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  throw new ModelUnavailableError(
    `${model.providerName} could not be reached after ${failures} attempt${failures === 1 ? '' : 's'} while reading the marking scheme.`,
    failures,
    lastError,
  );
}

/* ---------------------------- shared finishing ---------------------------- */

/**
 * Fills in criteria for any question whose scheme defined none.
 *
 * The absence of a rubric for one question must never stop the rest of the paper
 * being graded, so this runs per question and leaves everything else untouched.
 * Anything it fills in is marked `ai-inferred` from here to the UI. Questions
 * are taken one at a time: inference is a model call, and the provider's rate
 * limit is shared with everything else in flight.
 */
async function fillMissingCriteria(
  rubric: DraftRubric,
  model: GradingModel,
): Promise<{ rubric: DraftRubric; warnings: string[] }> {
  const warnings: string[] = [];
  const questions: DraftQuestion[] = [];

  for (const question of rubric.questions) {
    if (question.criteria.length > 0) {
      questions.push(question);
      continue;
    }

    const inferred = await inferCriteria(question, model);
    warnings.push(inferred.warning);
    questions.push({ ...question, criteria: inferred.criteria, criteriaSource: 'ai-inferred' as const });
  }

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
  const repairs: string[] = [];
  const repaired = {
    ...rubric,
    questions: rubric.questions.map((question) => {
      const sum = question.criteria.reduce((total, criterion) => total + criterion.maxMarks, 0);
      if (Math.abs(question.maxMarks - sum) < 1e-9) return question;
      repairs.push(
        `Question ${question.number}: the scheme states ${question.maxMarks} marks but its value points add up to ${sum}, so the question total was set to ${sum}. Check the value points.`,
      );
      return { ...question, maxMarks: sum };
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

  return { rubric: strict.data, source, warnings: [...warnings, ...repairs] };
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

/** A subject name for questions the paper did not label, from the first place one is printed. */
function deriveSubject(questionPaper: IngestedDocument | null, modelAnswer: IngestedDocument): string {
  const text = `${questionPaper?.fullText ?? ''}\n${modelAnswer.fullText}`;
  const match =
    /\b(Physics|Chemistry|Biology|Mathematics|Maths|Economics|Science|English|History|Geography|Accountancy|Business Studies|Computer Science|Political Science)\b/i.exec(
      text,
    );
  return match ? match[1]! : 'General';
}
