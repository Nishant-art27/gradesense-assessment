import { z } from 'zod';

/**
 * Stitching a document read in pieces back into whole questions.
 *
 * Each excerpt of a question paper or marking scheme comes back as a list of
 * partial entries. The join key is the question number as printed — never the
 * position in the document — so a question that straddles a chunk boundary is
 * reassembled, and a question the scheme covers but the paper omits (or the
 * reverse) is reported rather than silently dropped.
 *
 * Nothing here summarises. Text is concatenated in document order; criteria are
 * appended in the order the scheme listed them; guidance lines are kept unless
 * an identical line has already been kept from the same question.
 */

/* ------------------------------ chunk outputs ------------------------------ */

const continuation = {
  continuesFromPreviousChunk: z.boolean(),
  continuesIntoNextChunk: z.boolean(),
};

export const QuestionPaperChunkOutputSchema = z.object({
  questions: z.array(
    z.object({
      number: z.number().int(),
      subject: z.string(),
      prompt: z.string(),
      maxMarks: z.number().nullable(),
      requiresDiagram: z.boolean(),
      ...continuation,
    }),
  ),
});
export type QuestionPaperPart = z.infer<typeof QuestionPaperChunkOutputSchema>['questions'][number];

export const SchemeChunkOutputSchema = z.object({
  questions: z.array(
    z.object({
      number: z.number().int(),
      maxMarks: z.number().nullable(),
      modelAnswer: z.string(),
      guidance: z.array(z.string()),
      requiresDiagram: z.boolean(),
      criteria: z.array(z.object({ description: z.string(), maxMarks: z.number() })),
      ...continuation,
    }),
  ),
});
export type SchemePart = z.infer<typeof SchemeChunkOutputSchema>['questions'][number];

export const AnswerChunkOutputSchema = z.object({
  answers: z.array(
    z.object({
      questionNumber: z.number().int(),
      beginsInThisChunk: z.boolean(),
      firstWords: z.string().nullable(),
    }),
  ),
});
export type AnswerChunkOutput = z.infer<typeof AnswerChunkOutputSchema>;

/* -------------------------------- merging -------------------------------- */

export interface MergedPaperQuestion {
  number: number;
  subject: string;
  prompt: string;
  maxMarks: number | null;
  requiresDiagram: boolean;
  /** Which excerpts contributed, for the audit trail. */
  chunkIndices: number[];
}

export interface MergedSchemeQuestion {
  number: number;
  maxMarks: number | null;
  modelAnswer: string;
  guidance: string[];
  requiresDiagram: boolean;
  criteria: Array<{ description: string; maxMarks: number }>;
  chunkIndices: number[];
}

/** A part together with the excerpt it came from, in document order. */
export interface Sourced<T> {
  chunkIndex: number;
  entry: T;
}

const normalise = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** Joins two pieces of prose that may overlap at the seam or repeat outright. */
function joinText(existing: string, addition: string): string {
  const a = existing.trim();
  const b = addition.trim();
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  if (normalise(a) === normalise(b) || normalise(a).includes(normalise(b))) return a;
  if (normalise(b).includes(normalise(a))) return b;
  return `${a}\n${b}`;
}

export function mergeQuestionPaperParts(parts: Array<Sourced<QuestionPaperPart>>): Map<number, MergedPaperQuestion> {
  const merged = new Map<number, MergedPaperQuestion>();

  for (const { chunkIndex, entry } of parts) {
    const current = merged.get(entry.number);
    if (!current) {
      merged.set(entry.number, {
        number: entry.number,
        subject: entry.subject.trim(),
        prompt: entry.prompt.trim(),
        maxMarks: entry.maxMarks,
        requiresDiagram: entry.requiresDiagram,
        chunkIndices: [chunkIndex],
      });
      continue;
    }

    current.prompt = joinText(current.prompt, entry.prompt);
    if (current.subject.length === 0) current.subject = entry.subject.trim();
    // The first stated figure wins; a later excerpt that also states it is a
    // repeat of the same printed number, not a correction.
    if (current.maxMarks === null) current.maxMarks = entry.maxMarks;
    current.requiresDiagram = current.requiresDiagram || entry.requiresDiagram;
    if (!current.chunkIndices.includes(chunkIndex)) current.chunkIndices.push(chunkIndex);
  }

  return merged;
}

export function mergeSchemeParts(parts: Array<Sourced<SchemePart>>): Map<number, MergedSchemeQuestion> {
  const merged = new Map<number, MergedSchemeQuestion>();

  for (const { chunkIndex, entry } of parts) {
    const current = merged.get(entry.number);
    if (!current) {
      merged.set(entry.number, {
        number: entry.number,
        maxMarks: entry.maxMarks,
        modelAnswer: entry.modelAnswer.trim(),
        guidance: dedupe(entry.guidance),
        requiresDiagram: entry.requiresDiagram,
        criteria: dedupeCriteria(entry.criteria),
        chunkIndices: [chunkIndex],
      });
      continue;
    }

    current.modelAnswer = joinText(current.modelAnswer, entry.modelAnswer);
    current.guidance = dedupe([...current.guidance, ...entry.guidance]);
    current.criteria = dedupeCriteria([...current.criteria, ...entry.criteria]);
    if (current.maxMarks === null) current.maxMarks = entry.maxMarks;
    current.requiresDiagram = current.requiresDiagram || entry.requiresDiagram;
    if (!current.chunkIndices.includes(chunkIndex)) current.chunkIndices.push(chunkIndex);
  }

  return merged;
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = normalise(line);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(line.trim());
  }
  return out;
}

/**
 * Drops a criterion only when an identical one (same words, same marks) is
 * already present — the seam between two excerpts can repeat the point on the
 * boundary. Two points with the same words but different marks are both kept:
 * schemes do award the same step twice in different parts.
 */
function dedupeCriteria(
  criteria: Array<{ description: string; maxMarks: number }>,
): Array<{ description: string; maxMarks: number }> {
  const seen = new Set<string>();
  const out: Array<{ description: string; maxMarks: number }> = [];
  for (const criterion of criteria) {
    const description = criterion.description.trim();
    if (description.length === 0 || !(criterion.maxMarks > 0)) continue;
    const key = `${normalise(description)}|${criterion.maxMarks}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ description, maxMarks: criterion.maxMarks });
  }
  return out;
}

/* --------------------------------- joining --------------------------------- */

export interface JoinedQuestion {
  number: number;
  subject: string;
  prompt: string;
  maxMarks: number;
  modelAnswer: string;
  guidance: string[];
  requiresDiagram: boolean;
  criteria: Array<{ description: string; maxMarks: number }>;
  sources: { questionPaperChunks: number[]; schemeChunks: number[] };
}

export interface JoinOutcome {
  questions: JoinedQuestion[];
  /** Questions found in one document but not the other, or with no marks anywhere. */
  warnings: string[];
}

/**
 * Pairs each question's text with its marking by number.
 *
 * The total comes from the scheme when it states one, else from the paper,
 * else from the sum of the criteria. A question with no marks stated anywhere
 * and no criteria cannot be graded against anything, so it is left out and
 * said so — a rubric entry worth zero would be worse than an honest gap.
 */
export function joinQuestions(
  paper: Map<number, MergedPaperQuestion>,
  scheme: Map<number, MergedSchemeQuestion>,
  fallbackSubject: string,
): JoinOutcome {
  const numbers = [...new Set([...paper.keys(), ...scheme.keys()])].sort((a, b) => a - b);
  const questions: JoinedQuestion[] = [];
  const warnings: string[] = [];

  for (const number of numbers) {
    const fromPaper = paper.get(number);
    const fromScheme = scheme.get(number);

    if (fromPaper && !fromScheme && scheme.size > 0) {
      warnings.push(
        `Question ${number} is on the question paper but the marking scheme has nothing for it. Its criteria will have to be inferred or written by hand.`,
      );
    }
    if (fromScheme && !fromPaper && paper.size > 0) {
      warnings.push(
        `Question ${number} is in the marking scheme but was not found on the question paper. Its text is taken from the scheme's model answer.`,
      );
    }

    const criteria = fromScheme?.criteria ?? [];
    const criteriaSum = criteria.reduce((total, criterion) => total + criterion.maxMarks, 0);
    const maxMarks = fromScheme?.maxMarks ?? fromPaper?.maxMarks ?? (criteriaSum > 0 ? criteriaSum : null);

    if (maxMarks === null || maxMarks <= 0) {
      warnings.push(
        `Question ${number}: no marks were stated in either document and the scheme lists no value points, so it was left out of the rubric. Add it by hand if it should be marked.`,
      );
      continue;
    }

    questions.push({
      number,
      subject: fromPaper?.subject || fallbackSubject,
      prompt: fromPaper?.prompt ?? '',
      maxMarks,
      modelAnswer: fromScheme?.modelAnswer ?? '',
      guidance: fromScheme?.guidance ?? [],
      requiresDiagram: Boolean(fromPaper?.requiresDiagram || fromScheme?.requiresDiagram),
      criteria,
      sources: {
        questionPaperChunks: fromPaper?.chunkIndices ?? [],
        schemeChunks: fromScheme?.chunkIndices ?? [],
      },
    });
  }

  return { questions, warnings };
}
