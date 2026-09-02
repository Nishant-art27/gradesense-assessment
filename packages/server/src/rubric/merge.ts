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

    const stated = fromScheme?.maxMarks ?? fromPaper?.maxMarks ?? null;
    const reconciled = reconcileSummaryBox(fromScheme?.criteria ?? [], stated);
    if (reconciled.note) warnings.push(`Question ${number}: ${reconciled.note}`);
    const trimmed = trimToStatedTotal(reconciled.criteria, stated);
    if (trimmed.note) warnings.push(`Question ${number}: ${trimmed.note}`);

    const criteria = trimmed.criteria;
    const criteriaSum = criteria.reduce((total, criterion) => total + criterion.maxMarks, 0);
    const maxMarks = stated ?? (criteriaSum > 0 ? criteriaSum : null);

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
      guidance: [...reconciled.guidance, ...trimmed.guidance, ...(fromScheme?.guidance ?? [])],
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

/* ---------------------------- summary-box double count ---------------------------- */

type Point = { description: string; maxMarks: number };

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Points the model has labelled as belonging to the question's OR alternative. */
const looksLikeAlternative = (run: Point[]) =>
  run.some((point) => /\bOR\b|\balternative\b/.test(point.description));

/**
 * Undoes the commonest transcription mistake in a board-style marking scheme.
 *
 * Such schemes print each question twice over: a summary box giving the marks
 * for each part (2½ + ½ + 2 = 5), then the detailed steps with the marks for
 * each (½, ½, 1, … = 5). The prompt asks for the steps as criteria and the box
 * as model answer, but a model copying at speed sometimes lists both — and then
 * a five-mark question is worth ten. The signature is unmistakable: the points
 * split into a leading run and a trailing run that each add up to the stated
 * total. The coarser run is the box; it is moved into guidance as the mark
 * distribution, and the steps — the points examiners actually award — stay as
 * the criteria. Anything that does not fit this exact pattern is left alone.
 */
export function reconcileSummaryBox(
  criteria: Point[],
  statedTotal: number | null,
): { criteria: Point[]; guidance: string[]; note: string | null } {
  const untouched = { criteria, guidance: [], note: null };
  if (statedTotal === null || criteria.length < 2) return untouched;

  const total = criteria.reduce((sum, point) => sum + point.maxMarks, 0);
  if (!close(total, statedTotal * 2)) return untouched;

  let running = 0;
  for (let split = 1; split < criteria.length; split += 1) {
    running += criteria[split - 1]!.maxMarks;
    if (!close(running, statedTotal)) continue;

    const leading = criteria.slice(0, split);
    const trailing = criteria.slice(split);

    // An OR alternative is worth the same as the main question, so it produces
    // the same two-runs-of-the-total signature — but it is a different question,
    // not a finer description of this one. Leave it to `trimToStatedTotal`,
    // which keeps the main points and records the alternative as guidance.
    if (looksLikeAlternative(leading) || looksLikeAlternative(trailing)) return untouched;
    // The box is the coarser description; the box is also printed first, which
    // settles a tie.
    const [box, steps] = trailing.length < leading.length ? [trailing, leading] : [leading, trailing];

    const distribution = box.map((point) => `${point.description} — ${point.maxMarks}`).join('; ');
    return {
      criteria: steps,
      guidance: [`Mark distribution from the scheme's summary: ${distribution}.`],
      note: `the scheme's summary of marks (${box.map((p) => p.maxMarks).join(' + ')} = ${statedTotal}) was listed alongside its detailed steps, which would have doubled the question. The steps are kept as the criteria and the summary is recorded as guidance.`,
    };
  }

  return untouched;
}

/**
 * Keeps a question's criteria at the total the scheme states.
 *
 * After the summary box is dealt with, a model reading a board-style scheme can
 * still list more than the question is worth: a stray half-mark step under a
 * part whose marks are already counted, or the OR alternative's points next to
 * the main question's. The scheme prints the counted points first, so when the
 * leading run of points adds up to exactly the stated total, that run is the
 * rubric and everything after it is extra detail. The extra points are not
 * thrown away — they go into guidance, where the grader still reads them — but
 * they no longer inflate a five-mark question to eleven. If no run adds up
 * exactly, nothing is touched and the arithmetic repair downstream reports it.
 */
export function trimToStatedTotal(
  criteria: Point[],
  statedTotal: number | null,
): { criteria: Point[]; guidance: string[]; note: string | null } {
  const untouched = { criteria, guidance: [], note: null };
  if (statedTotal === null || criteria.length < 2) return untouched;

  const total = criteria.reduce((sum, point) => sum + point.maxMarks, 0);
  if (total <= statedTotal + 1e-6) return untouched;

  const keepRun = (kept: Point[], extra: Point[], where: 'first' | 'last') => {
    const listed = extra.map((point) => `${point.description} — ${point.maxMarks}`).join('; ');
    return {
      criteria: kept,
      guidance: [
        `Further points the scheme lists for this question, not counted separately because their marks fall within the criteria above (or belong to the OR alternative): ${listed}.`,
      ],
      note: `the value points added up to ${total} against a stated total of ${statedTotal}. The ${where} ${kept.length} points, which add up to ${statedTotal}, are kept as the criteria; the remaining ${extra.length} (${listed}) are recorded as guidance.`,
    };
  };

  let running = 0;
  for (let split = 1; split < criteria.length; split += 1) {
    running += criteria[split - 1]!.maxMarks;
    if (close(running, statedTotal)) return keepRun(criteria.slice(0, split), criteria.slice(split), 'first');
  }

  running = 0;
  for (let split = criteria.length - 1; split > 0; split -= 1) {
    running += criteria[split]!.maxMarks;
    if (close(running, statedTotal)) return keepRun(criteria.slice(split), criteria.slice(0, split), 'last');
  }

  return untouched;
}
