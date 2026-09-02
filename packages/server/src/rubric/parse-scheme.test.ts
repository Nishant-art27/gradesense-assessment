import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateRubricArithmetic } from '@gradesense/shared';
import { config } from '../config.js';
import { extractPdf } from '../ingest/pdf.js';
import { buildRubric, parseMarkingScheme, parseQuestionPaper } from './parse-scheme.js';

/**
 * Rubric extraction, run against the real provided PDFs.
 *
 * The rubric is the specification every mark is measured against, so these
 * assertions are deliberately exact: the criteria, their marks, and the grading
 * guidance must come out of the scheme unchanged. A rubric that is subtly wrong
 * is worse than one that fails to parse, because it marks a whole class wrongly
 * and says nothing.
 */

let schemeText: string;
let paperText: string;

beforeAll(async () => {
  const [scheme, paper] = await Promise.all([
    fs.readFile(path.join(config.paths.repoRoot, 'GradeSense MA.pdf')),
    fs.readFile(path.join(config.paths.repoRoot, 'GradeSense QP.pdf')),
  ]);
  schemeText = (await extractPdf(scheme)).fullText;
  paperText = (await extractPdf(paper)).fullText;
});

describe('reading the question paper', () => {
  it('finds every question with its prompt', () => {
    const prompts = parseQuestionPaper(paperText);

    expect(prompts.size).toBe(3);
    expect(prompts.get(1)?.subject).toBe('Science');
    expect(prompts.get(2)?.subject).toBe('English');
    expect(prompts.get(3)?.subject).toBe('Economics');
    expect(prompts.get(1)?.maxMarks).toBe(5);
    expect(prompts.get(1)?.prompt).toContain('simple electric circuit');
  });

  it('leaves out the candidate instructions that follow each question', () => {
    const prompts = parseQuestionPaper(paperText);
    expect(prompts.get(1)?.prompt).not.toContain('Expected answer');
  });
});

describe('reading the marking scheme', () => {
  it('finds every question and its criteria', () => {
    const scheme = parseMarkingScheme(schemeText);

    expect(scheme).toHaveLength(3);
    for (const question of scheme) {
      expect(question.criteria).toHaveLength(5);
      expect(question.declaredTotal).toBe(5);
      expect(question.modelAnswer.length).toBeGreaterThan(500);
    }
  });

  it('reads a criterion whose text wrapped before its mark', () => {
    // Q1's fourth criterion wraps mid-phrase in the PDF, with the "1" landing on
    // its own line. Joining those back together is the fiddly part of the parse.
    const [q1] = parseMarkingScheme(schemeText);
    const wrapped = q1!.criteria[3]!;

    expect(wrapped.description).toBe(
      "Correctly explains the relationship between resistance and current, including the relevant principle/Ohm's law",
    );
    expect(wrapped.maxMarks).toBe(1);
  });

  it('does not mistake a figure inside a criterion for its mark', () => {
    // "…the equilibrium at ₹30 and 60 units…" ends in a number that is not a mark.
    const scheme = parseMarkingScheme(schemeText);
    const equilibrium = scheme[2]!.criteria[1]!;

    expect(equilibrium.description).toContain('60 units');
    expect(equilibrium.maxMarks).toBe(1);
  });

  it('captures the grading guidance, which changes how the paper is marked', () => {
    const scheme = parseMarkingScheme(schemeText);

    const q1Guidance = scheme[0]!.guidance.join(' ');
    expect(q1Guidance).toMatch(/does not need to reproduce the model answer/i);
    expect(q1Guidance).toMatch(/voltmeter in series/i);

    // Q2's guidance is the one that matters most: it says a contrary conclusion
    // can still score full marks. Losing it would change every English mark.
    const q2Guidance = scheme[1]!.guidance.join(' ');
    expect(q2Guidance).toMatch(/open-ended/i);
    expect(q2Guidance).toMatch(/does not have to reach the same conclusion/i);
  });
});

describe('building a rubric from both documents', () => {
  it('produces the same rubric as the hand-written fixture', () => {
    const { rubric, warnings } = buildRubric(schemeText, paperText, { id: 'r', title: 'T' });

    // Q3 of the provided scheme has criteria but no "Important grading guidance"
    // block, and that asymmetry is reported rather than passed over silently.
    expect(warnings).toEqual([
      'Question 3: the scheme gives no grading guidance, so the grader applies the criteria without further instruction.',
    ]);
    expect(rubric).not.toBeNull();
    expect(rubric!.totalMarks).toBe(15);
    expect(rubric!.questions).toHaveLength(3);
    expect(validateRubricArithmetic(rubric!)).toEqual([]);

    const ids = rubric!.questions.flatMap((question) => question.criteria.map((c) => c.id));
    expect(ids).toEqual([
      'q1c1', 'q1c2', 'q1c3', 'q1c4', 'q1c5',
      'q2c1', 'q2c2', 'q2c3', 'q2c4', 'q2c5',
      'q3c1', 'q3c2', 'q3c3', 'q3c4', 'q3c5',
    ]);
  });

  it('works out which questions award marks for a diagram', () => {
    const { rubric } = buildRubric(schemeText, paperText, { id: 'r', title: 'T' });

    expect(rubric!.questions[0]!.requiresDiagram).toBe(true); // circuit
    expect(rubric!.questions[1]!.requiresDiagram).toBe(false); // essay
    expect(rubric!.questions[2]!.requiresDiagram).toBe(true); // graph
  });

  it('takes the prompt from the question paper, not the scheme', () => {
    const { rubric } = buildRubric(schemeText, paperText, { id: 'r', title: 'T' });
    expect(rubric!.questions[0]!.prompt).toContain('illustrate your explanation');
  });

  it('still produces a rubric when no question paper is supplied', () => {
    const { rubric, warnings } = buildRubric(schemeText, null, { id: 'r', title: 'T' });

    expect(rubric).not.toBeNull();
    expect(rubric!.totalMarks).toBe(15);
    // …but says so, because the grader will not see the question as it was set.
    expect(warnings.join(' ')).toMatch(/no question text was found/i);
  });

  it('marks every question as instructor-defined when the scheme supplies criteria', () => {
    const { rubric } = buildRubric(schemeText, paperText, { id: 'r', title: 'T' });
    expect(rubric!.questions.every((question) => question.criteriaSource === 'instructor')).toBe(true);
  });

  /*
   * A question with no rubric table used to be dropped here, which silently
   * shrank the paper's total and lost the question. It is now kept with no
   * criteria for `extractRubric` to infer — one unrubricked question must never
   * stop the rest of the paper being graded.
   */
  it('keeps a question whose scheme defines no criteria, rather than dropping it', () => {
    const partial = [
      'Q1 — Science',
      'Model Answer — 3 marks',
      'Some prose.',
      'Marking rubric',
      'Criterion Marks',
      'First point 1',
      'Second point 2',
      'Total 3',
      'Q2 — History',
      'Model Answer — 4 marks',
      'The treaty was signed in 1919 and imposed reparations.',
    ].join('\n');

    const { rubric, warnings } = buildRubric(partial, null, { id: 'r', title: 'T' });

    expect(rubric!.questions).toHaveLength(2);
    const q2 = rubric!.questions[1]!;
    expect(q2.criteria).toEqual([]);
    // Its marks survive from the scheme's stated total, so inference has a target.
    expect(q2.maxMarks).toBe(4);
    expect(warnings.join(' ')).toMatch(/Question 2: the scheme defines no marking criteria/i);
  });

  it('reports a scheme it cannot read instead of inventing one', () => {
    const { rubric, warnings } = buildRubric('Some prose with no structure at all.', null, {
      id: 'r',
      title: 'T',
    });

    expect(rubric).toBeNull();
    expect(warnings.join(' ')).toMatch(/no question headings/i);
  });

  it('flags a stated total that disagrees with its criteria, and trusts the criteria', () => {
    const inconsistent = [
      'Q1 — Science',
      'Model Answer — 9 marks',
      'Some model answer prose.',
      'Marking rubric',
      'Criterion Marks',
      'First point 1',
      'Second point 2',
      'Total 9',
    ].join('\n');

    const { rubric, warnings } = buildRubric(inconsistent, null, { id: 'r', title: 'T' });

    // Marks are awarded against criteria, so the criteria decide the total.
    expect(rubric!.questions[0]!.maxMarks).toBe(3);
    expect(warnings.join(' ')).toMatch(/states 9 marks but its criteria add up to 3/i);
  });
});
