import fs from 'node:fs/promises';
import { RubricSchema, validateRubricArithmetic, type Rubric } from '@gradesense/shared';
import { config } from './config.js';
import { RubricInvalidError } from './errors.js';

/**
 * Where the marking rubric comes from.
 *
 * The rubric is loaded from `fixtures/rubric.json`, which is a faithful
 * transcription of the marking scheme in the provided model-answer paper —
 * criteria, marks, the model answer prose, and the per-question grading guidance
 * ("a student may reach the opposite conclusion and still score 5/5").
 *
 * Why a checked-in file rather than parsing the model-answer PDF with the model
 * on every run: the rubric is the specification the whole system is measured
 * against. Re-deriving it from a PDF each time would make marks depend on how
 * well an extraction step happened to go that day, and would make the test suite
 * non-deterministic for no benefit. Extracting it once, by hand, and validating
 * its arithmetic at load time is both more honest and more reliable.
 *
 * The uploaded model-answer PDF is still read and stored — it is what the
 * teacher sees alongside the grading, and its text is available to the prompt —
 * but it is not re-parsed into a rubric behind the scenes.
 */

let cached: Rubric | null = null;

export async function loadRubric(): Promise<Rubric> {
  if (cached) return cached;

  let raw: string;
  try {
    raw = await fs.readFile(config.paths.rubric, 'utf8');
  } catch (error) {
    throw new RubricInvalidError(`Could not read the rubric at ${config.paths.rubric}.`, [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new RubricInvalidError('The rubric file is not valid JSON.', [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  const parsed = RubricSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new RubricInvalidError(
      'The rubric file does not match the expected shape.',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  // Refuse a rubric whose marks do not add up. Marking against it would make the
  // "total equals the sum of the rubric points" rule impossible to honour.
  const problems = validateRubricArithmetic(parsed.data);
  if (problems.length > 0) {
    throw new RubricInvalidError('The rubric marks do not add up.', problems);
  }

  cached = parsed.data;
  return cached;
}

/** Test hook: forget the cached rubric. */
export function resetRubricCache(): void {
  cached = null;
}
