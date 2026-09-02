import type { Criterion, DraftQuestion } from '@gradesense/shared';
import type { GradingModel } from '../grading/model.js';

/**
 * Deriving markable points for a question whose scheme gave none.
 *
 * A marking scheme sometimes covers only part of a paper. The rest still has to
 * be gradeable — dropping a question, or refusing the whole run because one
 * question lacks a rubric, is worse than marking it against reasonable criteria
 * and saying plainly that is what happened.
 *
 * Two rules govern everything here:
 *
 *  1. Inferred criteria must sum to the marks the instructor stated. The scheme
 *     or the question paper says the question is worth 5; inference decides how
 *     those 5 are split, never how many there are.
 *  2. The result is labelled `ai-inferred` from this point to the UI and never
 *     presented as the instructor's. A teacher deciding whether to trust a mark
 *     needs to know whose standard produced it.
 */

export const CRITERIA_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['criteria'],
  properties: {
    criteria: {
      type: 'array',
      description: 'The markable points this answer should be judged on.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'maxMarks'],
        properties: {
          description: {
            type: 'string',
            description:
              'One specific, checkable thing the answer must do, worded as an examiner would word a rubric row.',
          },
          maxMarks: { type: 'number', description: 'Marks for this point.' },
        },
      },
    },
  },
};

export const CRITERIA_SYSTEM_PROMPT = `You are an experienced examiner writing the missing rubric for one question.

The marking scheme provided no criteria for this question, so you must derive them from the question and the model answer.

Rules:
- Produce criteria that together account for EXACTLY the marks the question is worth. Do not invent extra marks and do not leave marks unallocated.
- Each criterion must be one specific, checkable thing — "identifies the equilibrium price and quantity", not "shows good understanding".
- Derive them from what the model answer actually demonstrates, in the order the model answer covers them.
- Prefer whole marks. Use halves only if the total cannot otherwise be met.
- Word each criterion as an examiner would word a rubric row, not as a comment on a particular student.`;

export function buildCriteriaPrompt(question: DraftQuestion): string {
  return `Write the marking criteria for this question.

QUESTION ${question.number} (${question.subject}) — worth exactly ${question.maxMarks} marks in total.

QUESTION AS SET
${question.prompt.length > 0 ? question.prompt : '(not supplied)'}

MODEL ANSWER — derive the criteria from what this demonstrates
"""
${question.modelAnswer}
"""

Return criteria whose marks sum to exactly ${question.maxMarks}.`;
}

export interface InferredCriteria {
  criteria: Criterion[];
  /** How it was produced, for the warning the teacher sees. */
  method: 'model' | 'fallback';
  warning: string;
}

/**
 * Infers criteria for one question.
 *
 * Falls back to a single whole-question criterion when no model is available —
 * with the deterministic provider there is nothing to infer *with*, and a
 * placeholder that a human can edit beats failing the whole paper. The grading
 * pipeline treats such a question as ungraded rather than pretending to mark it.
 */
export async function inferCriteria(
  question: DraftQuestion,
  model: GradingModel,
): Promise<InferredCriteria> {
  const fallback: InferredCriteria = {
    criteria: [
      {
        id: `${question.id}c1`,
        description: `Answer addresses the question and covers the substance of the model answer.`,
        maxMarks: question.maxMarks,
      },
    ],
    method: 'fallback',
    warning:
      `Question ${question.number}: no criteria could be inferred automatically, so the whole question sits on one placeholder point. Please write the criteria yourself before marking.`,
  };

  if (!model.inferCriteria) return fallback;

  let parsed: unknown;
  try {
    const response = await model.inferCriteria({
      systemPrompt: CRITERIA_SYSTEM_PROMPT,
      prompt: buildCriteriaPrompt(question),
      schema: CRITERIA_JSON_SCHEMA,
    });
    parsed = response.data;
  } catch {
    // Inference is best-effort. A failure here must not fail the extraction.
    return fallback;
  }

  const rows = readRows(parsed);
  if (rows.length === 0) return fallback;

  const criteria = normaliseToTotal(rows, question);

  return {
    criteria: criteria.map((criterion, index) => ({
      id: `${question.id}c${index + 1}`,
      description: criterion.description,
      maxMarks: criterion.maxMarks,
    })),
    method: 'model',
    warning:
      `Question ${question.number}: the marking scheme defined no criteria, so these ${criteria.length} were inferred from the model answer. Review them before marking.`,
  };
}

function readRows(data: unknown): Array<{ description: string; maxMarks: number }> {
  if (typeof data !== 'object' || data === null) return [];
  const rows = (data as { criteria?: unknown }).criteria;
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => {
      const entry = (row ?? {}) as { description?: unknown; maxMarks?: unknown };
      return {
        description: typeof entry.description === 'string' ? entry.description.trim() : '',
        maxMarks: typeof entry.maxMarks === 'number' && Number.isFinite(entry.maxMarks) ? entry.maxMarks : 0,
      };
    })
    .filter((row) => row.description.length > 0 && row.maxMarks > 0);
}

/**
 * Forces inferred marks to sum to the instructor's stated total.
 *
 * The model is asked for this and usually complies, but "usually" is not a
 * property a mark scheme can rest on. Marks are scaled proportionally and the
 * rounding drift is absorbed by the last criterion, so the arithmetic is exact
 * by construction rather than by trust — the same reason totals are recomputed
 * everywhere else in this pipeline.
 */
function normaliseToTotal(
  rows: Array<{ description: string; maxMarks: number }>,
  question: DraftQuestion,
): Array<{ description: string; maxMarks: number }> {
  const target = question.maxMarks;
  const sum = rows.reduce((total, row) => total + row.maxMarks, 0);
  if (sum <= 0) return rows;
  if (Math.abs(sum - target) < 1e-9) return rows;

  const scaled = rows.map((row) => ({
    description: row.description,
    maxMarks: Math.max(0.5, Math.round((row.maxMarks / sum) * target * 2) / 2),
  }));

  const scaledSum = scaled.reduce((total, row) => total + row.maxMarks, 0);
  const last = scaled[scaled.length - 1];
  if (last) last.maxMarks = Number(Math.max(0.5, last.maxMarks + (target - scaledSum)).toFixed(4));

  return scaled;
}
