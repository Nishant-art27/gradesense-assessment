import type { PageText, Question } from '@gradesense/shared';
import type { GradingModel } from '../grading/model.js';
import { RequestTooLargeError } from '../errors.js';
import { isTransientModelError } from '../grading/providers/transient.js';
import { AnswerChunkOutputSchema } from '../rubric/merge.js';
import { chunkDocument, splitChunk, type DocumentChunk } from './chunk.js';
import type { AnswerSegment } from './segment.js';

/**
 * Working out which part of an answer sheet answers which question, when the
 * sheet has no headings to split on.
 *
 * `segmentAnswers` handles the ordinary case exactly and for free. When it
 * cannot — no "Answer 3" markers anywhere — its fallback hands the entire sheet
 * to every question. For a three-question paper that is the whole document
 * three times over, and for a long sheet it is more than one request can hold.
 *
 * So the sheet is read in pieces, each piece is shown to the model with the
 * list of questions, and the model says which questions that piece answers and
 * where each answer begins. The pieces are then reassembled into one segment
 * per question. Nothing is summarised or dropped: every piece of text ends up
 * in the segment of some question — the one it belongs to when the model found
 * the boundary, or every question it mentions when it did not.
 */

export interface AttributeInput {
  pages: PageText[];
  questions: Question[];
  model: GradingModel;
  /** Tokens of answer text per request. */
  chunkTokens: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
}

export interface AttributionOutcome {
  segments: AnswerSegment[];
  /** How many requests it took, for the audit trail. */
  requests: number;
}

interface Located {
  questionNumber: number;
  /** Offset into the joined text of all chunks. */
  offset: number;
  chunkIndex: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Returns null when this provider cannot attribute, or when every attempt to
 * do so failed — the caller then keeps the whole-document fallback, which is
 * worse but honest, and the result is flagged for review either way.
 */
export async function attributeAnswers(input: AttributeInput): Promise<AttributionOutcome | null> {
  const { model, questions } = input;
  if (!model.attributeAnswerChunk) return null;

  const numbers = questions.map((question) => question.number);
  const initial = chunkDocument(input.pages, { maxTokens: input.chunkTokens, expectedNumbers: numbers });

  // Chunks may be split further if the provider still refuses one, so the list
  // is a queue rather than a fixed array.
  const queue: DocumentChunk[] = [...initial];
  const processed: DocumentChunk[] = [];
  const located: Located[] = [];
  const mentions = new Map<number, Set<number>>();
  let requests = 0;
  let joinedLength = 0;

  while (queue.length > 0) {
    const chunk = queue.shift()!;

    let output;
    try {
      requests += 1;
      output = await withRetries(
        () => model.attributeAnswerChunk!({ chunk, questions: questions.map((q) => ({ number: q.number, prompt: q.prompt })) }),
        input.maxAttempts,
        input.retryBaseDelayMs,
      );
    } catch (error) {
      if (error instanceof RequestTooLargeError) {
        const smaller = splitChunk(chunk, Math.max(150, Math.floor(chunk.estimatedTokens / 2)));
        if (smaller.length > 1) {
          queue.unshift(...smaller);
          continue;
        }
      }
      // Attribution is best-effort; the fallback segmentation still stands.
      return null;
    }

    const parsed = AnswerChunkOutputSchema.safeParse(output.data);
    if (!parsed.success) {
      // Unusable output: try the excerpt in halves before giving up on it.
      const smaller = splitChunk(chunk, Math.max(150, Math.floor(chunk.estimatedTokens / 2)));
      if (smaller.length > 1 && (chunk.part?.count ?? 1) < 8) {
        queue.unshift(...smaller);
        continue;
      }
    }

    const chunkStart = joinedLength;
    processed.push(chunk);
    joinedLength += chunk.text.length + 1;

    if (!parsed.success) continue;

    for (const answer of parsed.data.answers) {
      if (!numbers.includes(answer.questionNumber)) continue;

      if (!mentions.has(answer.questionNumber)) mentions.set(answer.questionNumber, new Set());
      mentions.get(answer.questionNumber)!.add(processed.length - 1);

      if (answer.beginsInThisChunk && !located.some((entry) => entry.questionNumber === answer.questionNumber)) {
        const offset = locate(chunk.text, answer.firstWords);
        located.push({
          questionNumber: answer.questionNumber,
          offset: chunkStart + (offset ?? 0),
          chunkIndex: processed.length - 1,
        });
      }
    }
  }

  if (located.length === 0 && mentions.size === 0) return null;

  const joined = processed.map((chunk) => chunk.text).join('\n');
  located.sort((a, b) => a.offset - b.offset);

  const segments = questions.map((question): AnswerSegment => {
    const start = located.find((entry) => entry.questionNumber === question.number);

    if (start) {
      const following = located.find((entry) => entry.offset > start.offset);
      return {
        questionId: question.id,
        number: question.number,
        text: joined.slice(start.offset, following ? following.offset : undefined).trim(),
        startPage: processed[start.chunkIndex]?.startPage ?? 0,
        approximate: false,
      };
    }

    // Mentioned but no boundary found: keep every piece it appears in, whole.
    const indices = [...(mentions.get(question.number) ?? [])].sort((a, b) => a - b);
    return {
      questionId: question.id,
      number: question.number,
      text: indices.map((index) => processed[index]!.text).join('\n').trim(),
      startPage: indices.length > 0 ? processed[indices[0]!]!.startPage : 0,
      approximate: true,
    };
  });

  return { segments, requests };
}

/** Finds where the quoted opening words sit in the chunk, tolerating whitespace differences. */
function locate(text: string, firstWords: string | null): number | null {
  if (!firstWords) return null;
  const needle = firstWords.trim();
  if (needle.length === 0) return null;

  const direct = text.indexOf(needle);
  if (direct >= 0) return direct;

  const pattern = needle
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  const match = new RegExp(pattern, 'i').exec(text);
  return match ? match.index : null;
}

async function withRetries<T>(task: () => Promise<T>, maxAttempts: number, baseDelayMs: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!isTransientModelError(error) || attempt === maxAttempts) throw error;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}
