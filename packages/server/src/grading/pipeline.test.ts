import { beforeAll, describe, expect, it } from 'vitest';
import {
  checkResultInvariants,
  type Annotation,
  type GradingResult,
  type Rubric,
} from '@gradesense/shared';
import { ModelUnavailableError } from '../errors.js';
import { loadRubric } from '../rubric-source.js';
import { loadAnswerFixture, type AnswerSlug } from '../test-support.js';
import { runGrading } from './pipeline.js';
import type { GradingModel } from './model.js';
import { MockGradingModel } from './providers/mock.js';
import {
  FabricatedEvidenceGradingModel,
  FailingGradingModel,
  UnauthorisedGradingModel,
  FlakyGradingModel,
  MalformedGradingModel,
  OverscoringGradingModel,
} from './providers/faults.js';

/**
 * The cases the brief asks for, plus the invariants that must hold whatever the
 * model does.
 *
 * Everything runs against the deterministic mock or a deliberately misbehaving
 * provider, so the suite needs no API key and a failure means the pipeline
 * changed behaviour rather than a model changing its mind.
 */

let rubric: Rubric;

beforeAll(async () => {
  rubric = await loadRubric();
});

async function grade(
  slug: AnswerSlug,
  model: GradingModel = new MockGradingModel(),
): Promise<{ result: GradingResult; annotations: Annotation[] }> {
  const { document, bytes } = await loadAnswerFixture(slug);
  return runGrading({ rubric, studentDocument: document, studentPdfBytes: bytes, model });
}

/** Marks for one criterion, by id. */
function markFor(result: GradingResult, criterionId: string): number {
  for (const question of result.questions) {
    const criterion = question.criteria.find((entry) => entry.criterionId === criterionId);
    if (criterion) return criterion.awardedMarks;
  }
  throw new Error(`No criterion "${criterionId}" in the result.`);
}

function questionByNumber(result: GradingResult, number: number) {
  const question = result.questions.find((entry) => entry.number === number);
  if (!question) throw new Error(`No question ${number} in the result.`);
  return question;
}

/* ========================================================================== *
 * Required case 1 — a fully correct answer
 * ========================================================================== */

describe('a fully correct answer', () => {
  it('is awarded full marks with no invented deductions', async () => {
    const { result, annotations } = await grade('fully-correct');

    expect(result.totalMarks).toBe(15);
    expect(result.maxMarks).toBe(15);
    expect(result.questions.every((question) => question.awardedMarks === question.maxMarks)).toBe(true);
    expect(result.questions.every((question) => question.state === 'graded')).toBe(true);

    // Nothing to correct means nothing drawn on the paper.
    expect(annotations.filter((annotation) => annotation.kind !== 'praise')).toHaveLength(0);
  });

  it('is confident and needs no human review', async () => {
    const { result } = await grade('fully-correct');

    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.requiresHumanReview).toBe(false);
    expect(result.reviewReasons).toHaveLength(0);
  });
});

/* ========================================================================== *
 * Required case 2 — a partially correct answer (the flagship paper)
 * ========================================================================== */

describe('a partially correct answer', () => {
  it('lands on the score the error key predicts', async () => {
    const { result } = await grade('student-answer');

    // docs/error-key.md derives 7.5 from the planted mistakes.
    expect(result.totalMarks).toBe(7.5);
    expect(questionByNumber(result, 1).awardedMarks).toBe(2.5);
    expect(questionByNumber(result, 2).awardedMarks).toBe(3);
    expect(questionByNumber(result, 3).awardedMarks).toBe(2);
  });

  it('penalises exactly the planted mistakes and credits the rest', async () => {
    const { result } = await grade('student-answer');

    // Voltmeter wired in series — the substantive error the marking scheme names.
    expect(markFor(result, 'q1c2')).toBe(0);
    // Reasoning right, Ohm's law written wrong: half credit, not zero.
    expect(markFor(result, 'q1c4')).toBe(0.5);
    // No conventional-current direction shown.
    expect(markFor(result, 'q1c5')).toBe(0);
    // Opposing viewpoint gestured at in one line; examples unsupported.
    expect(markFor(result, 'q2c3')).toBe(0);
    expect(markFor(result, 'q2c4')).toBe(0);
    // Graph axes swapped; shortage/surplus reversed; new equilibrium never stated.
    expect(markFor(result, 'q3c1')).toBe(0);
    expect(markFor(result, 'q3c3')).toBe(0);
    expect(markFor(result, 'q3c5')).toBe(0);

    // Correct content still earns its marks.
    expect(markFor(result, 'q1c1')).toBe(1);
    expect(markFor(result, 'q1c3')).toBe(1);
    expect(markFor(result, 'q2c1')).toBe(1);
    expect(markFor(result, 'q2c5')).toBe(1);
    expect(markFor(result, 'q3c2')).toBe(1);
    expect(markFor(result, 'q3c4')).toBe(1);
  });

  it('grades the essay on reasoning rather than agreement with the model answer', async () => {
    const { result } = await grade('student-answer');
    const english = questionByNumber(result, 2);

    // The paper argues the opposite of the model answer. The marking guidance
    // says that must not cost marks, so position, argument and conclusion all
    // score — only the genuinely thin parts are penalised.
    expect(markFor(result, 'q2c1')).toBe(1);
    expect(markFor(result, 'q2c2')).toBe(1);
    expect(english.awardedMarks).toBe(3);
  });

  it('anchors its annotations to real positions on the page', async () => {
    const { annotations } = await grade('student-answer');

    expect(annotations.length).toBeGreaterThan(8);

    const placed = annotations.filter((annotation) => annotation.anchorStatus !== 'unresolved');
    // The large majority should land on located text, not in the margin.
    expect(placed.length / annotations.length).toBeGreaterThan(0.8);

    for (const annotation of annotations) {
      expect(annotation.rect.page).toBeGreaterThanOrEqual(0);
      expect(annotation.rect.page).toBeLessThan(2);
      expect(annotation.rect.x).toBeGreaterThanOrEqual(0);
      expect(annotation.rect.x + annotation.rect.width).toBeLessThanOrEqual(1.0001);
      expect(annotation.rect.y + annotation.rect.height).toBeLessThanOrEqual(1.0001);
      expect(annotation.rect.width).toBeGreaterThan(0);
      expect(annotation.rect.height).toBeGreaterThan(0);
    }
  });

  it('reports the diagram fault as a region, since there is no text to quote', async () => {
    const { annotations } = await grade('student-answer');

    const regions = annotations.filter((annotation) => annotation.anchorStatus === 'region');
    expect(regions.length).toBeGreaterThan(0);
    // A region anchor is approximate, and the result says so out loud.
    const q3 = annotations.find(
      (annotation) => annotation.criterionId === 'q3c1' && annotation.anchorStatus === 'region',
    );
    expect(q3).toBeDefined();
  });

  /*
   * A diagram annotation is a big filled box, so getting its extent wrong is
   * not a cosmetic problem — it defaces whatever it spills onto. The first
   * version used hardcoded coordinates that started below the circuit and ended
   * inside the English answer below it. The region is now measured from the
   * diagram's caption and labels, and these assertions hold it there.
   */
  it('sizes the diagram region to the diagram, not into the next answer', async () => {
    const { document } = await loadAnswerFixture('student-answer');
    const { annotations } = await grade('student-answer');

    const region = annotations.find(
      (annotation) => annotation.criterionId === 'q1c5' && annotation.anchorStatus === 'region',
    );
    expect(region).toBeDefined();
    expect(region!.rect.page).toBe(0);

    const runsOn = (page: number) => document.pages[page]!.runs;
    const find = (needle: string, page = 0) => {
      const run = runsOn(page).find((entry) => entry.text.includes(needle));
      if (!run) throw new Error(`No run containing "${needle}" on page ${page}.`);
      return run.rect;
    };

    const caption = find('Circuit diagram');
    const nextAnswer = find('Answer 2 - English');
    const top = region!.rect.y;
    const bottom = region!.rect.y + region!.rect.height;

    // It must cover the caption and the labels beneath it...
    expect(top).toBeLessThanOrEqual(caption.y);
    expect(bottom).toBeGreaterThan(find('voltmeter').y);
    // ...and stop before the next question begins.
    expect(bottom).toBeLessThan(nextAnswer.y);
  });

  it('puts the graph region on the page the graph is actually on', async () => {
    const { document } = await loadAnswerFixture('student-answer');
    const { annotations } = await grade('student-answer');

    const region = annotations.find(
      (annotation) => annotation.criterionId === 'q3c1' && annotation.anchorStatus === 'region',
    );
    expect(region).toBeDefined();

    // The Q3 answer starts on page 1 but its graph runs over onto page 2.
    const captionPage = document.pages.findIndex((page) =>
      page.runs.some((run) => run.text.includes('Demand and supply graph')),
    );
    expect(region!.rect.page).toBe(captionPage);
    expect(region!.rect.height).toBeLessThan(0.35);
  });

  it('flags the weakest question for review even though the paper average looks fine', async () => {
    const { result } = await grade('student-answer');

    expect(result.requiresHumanReview).toBe(true);
    expect(result.reviewReasons.join(' ')).toMatch(/Question 3/);
  });
});

/* ========================================================================== *
 * Required case 3 — an incorrect answer
 * ========================================================================== */

describe('an incorrect answer', () => {
  it('scores near zero', async () => {
    const { result } = await grade('incorrect');

    expect(result.totalMarks).toBe(0);
    expect(result.requiresHumanReview).toBe(true);
  });

  it('backs every deduction with a quote that is actually in the answer', async () => {
    const { result } = await grade('incorrect');

    const deductions = result.questions
      .flatMap((question) => question.criteria)
      .filter((criterion) => criterion.status === 'incorrect');

    expect(deductions.length).toBeGreaterThan(4);

    for (const criterion of deductions) {
      // "Feedback must be supported by evidence from the student answer."
      expect(criterion.evidence, `${criterion.criterionId} has no evidence`).not.toBeNull();
      expect(criterion.evidence!.verified, `${criterion.criterionId} evidence unverified`).toBe(true);
      expect(criterion.evidence!.rects.length).toBeGreaterThan(0);
    }
  });
});

/* ========================================================================== *
 * Required case 4 — a blank answer
 * ========================================================================== */

describe('a blank answer', () => {
  it('scores zero without ever calling the grading model', async () => {
    const model = new MockGradingModel();
    const { result, annotations } = await grade('blank', model);

    // The point of the pre-check: an empty paper costs nothing to mark.
    expect(model.callCount).toBe(0);

    expect(result.totalMarks).toBe(0);
    expect(result.questions.every((question) => question.state === 'blank')).toBe(true);
    expect(annotations).toHaveLength(0);
  });

  it('is flagged for a human rather than treated as a settled zero', async () => {
    const { result } = await grade('blank');

    expect(result.requiresHumanReview).toBe(true);
    expect(result.reviewReasons.join(' ')).toMatch(/unanswered/i);
    expect(result.audit.filter((event) => event.kind === 'blank_answer_detected')).toHaveLength(3);
  });
});

/* ========================================================================== *
 * Required case 5 — OCR-like spelling errors
 * ========================================================================== */

describe('an answer with OCR-like spelling errors', () => {
  it('still credits correct content despite the character damage', async () => {
    const { result } = await grade('ocr-errors');

    // Same content as the fully correct paper, read through a bad scan.
    expect(result.totalMarks).toBe(15);
  });

  it('reports the misspellings separately instead of deducting for them', async () => {
    const { result, annotations } = await grade('ocr-errors');

    const spelling = annotations.filter((annotation) => annotation.kind === 'spelling');
    expect(spelling.length).toBeGreaterThan(3);

    // Surface errors annotate but never cost marks.
    expect(result.totalMarks).toBe(result.maxMarks);
    for (const annotation of spelling) {
      expect(annotation.criterionId).toBeNull();
      expect(annotation.severity).toBe('minor');
    }
  });

  it('anchors the damaged quotes by fuzzy match', async () => {
    const { annotations } = await grade('ocr-errors');

    for (const annotation of annotations) {
      expect(annotation.anchorStatus).not.toBe('unresolved');
    }
  });
});

/* ========================================================================== *
 * Required case 6 — malformed or incomplete model output
 * ========================================================================== */

describe('malformed model output', () => {
  it('is repaired by re-asking, and the repair is recorded', async () => {
    const model = new MalformedGradingModel('then-valid');
    const { result } = await grade('student-answer', model);

    // One bad response then a good one, for each of the three questions.
    expect(model.attempts).toBe(6);
    expect(result.questions.every((question) => question.state === 'graded')).toBe(true);
    expect(result.audit.filter((event) => event.kind === 'malformed_output_repaired')).toHaveLength(3);

    // Having to re-ask costs confidence, and that shows.
    expect(result.confidence).toBeLessThan(0.8);
    expect(result.requiresHumanReview).toBe(true);
  });

  it('degrades to "ungraded" rather than inventing marks when it never recovers', async () => {
    const { result } = await grade('student-answer', new MalformedGradingModel('always'));

    expect(result.questions.every((question) => question.state === 'ungraded')).toBe(true);
    expect(result.totalMarks).toBe(0);
    expect(result.confidence).toBe(0);

    // A zero we could not justify must not look like a zero the student earned.
    expect(result.reviewReasons.join(' ')).toMatch(/could not be marked/i);
    expect(
      result.audit.filter((event) => event.kind === 'malformed_output_unrecoverable'),
    ).toHaveLength(3);
  });

  it.each([['not-json'], ['truncated'], ['wrong-shape']] as const)(
    'survives %s output without throwing',
    async (shape) => {
      const { result } = await grade('student-answer', new MalformedGradingModel('always', shape));

      expect(checkResultInvariants(result)).toEqual([]);
      expect(result.requiresHumanReview).toBe(true);
    },
  );
});

/* ========================================================================== *
 * Required case 7 — a model / API failure
 * ========================================================================== */

describe('a model or API failure', () => {
  it.each([['server'], ['rate_limit'], ['connection']] as const)(
    'retries a %s failure and then reports the outage instead of marks',
    async (kind) => {
      const model = new FailingGradingModel(kind);

      await expect(grade('student-answer', model)).rejects.toThrow(ModelUnavailableError);
      // Three attempts, as configured — not one, and not an infinite loop.
      expect(model.attempts).toBe(3);
    },
  );

  it('surfaces as a retryable 503 so the caller knows to try again', async () => {
    const model = new FailingGradingModel('server');

    await expect(grade('student-answer', model)).rejects.toMatchObject({
      code: 'model_unavailable',
      status: 503,
      retryable: true,
    });
  });

  /*
   * A rejected key reached the browser as Google's raw error body — a teacher
   * marking a paper was shown a wall of JSON about OAuth 2 access tokens and
   * `ACCESS_TOKEN_TYPE_UNSUPPORTED`. The failure was real; the way it was
   * reported told them nothing they could act on.
   */
  describe('a provider that rejects the key', () => {
    it('is not retried, because no number of attempts fixes a bad key', async () => {
      const model = new UnauthorisedGradingModel();

      await expect(grade('student-answer', model)).rejects.toMatchObject({
        code: 'model_auth_failed',
        retryable: false,
      });
      expect(model.attempts).toBe(1);
    });

    it('says the key was rejected, and where to fix it', async () => {
      await expect(grade('student-answer', new UnauthorisedGradingModel())).rejects.toThrow(
        /rejected the API key.*\.env/is,
      );
    });

    it('never puts the raw JSON body from the provider in front of the user', async () => {
      const error = await grade('student-answer', new UnauthorisedGradingModel()).catch((e) => e);

      const shown = [error.message, ...error.details].join(' ');
      expect(shown).not.toContain('@type');
      expect(shown).not.toContain('type.googleapis.com');
      expect(shown).not.toContain('{');
    });

    it('still keeps enough of the reason to diagnose it', async () => {
      const error = await grade('student-answer', new UnauthorisedGradingModel()).catch((e) => e);

      expect(error.details.join(' ')).toMatch(/gemini said:/i);
      expect(error.details.join(' ')).toMatch(/invalid authentication credentials/i);
      // Trimmed to one line, not the whole body.
      expect(error.details.every((line: string) => line.length <= 240)).toBe(true);
    });

    it('treats a 403 the same way', async () => {
      await expect(grade('student-answer', new UnauthorisedGradingModel(403))).rejects.toMatchObject(
        { code: 'model_auth_failed' },
      );
    });
  });

  it('recovers when a transient failure clears on retry', async () => {
    const model = new FlakyGradingModel(1);
    const { result } = await grade('student-answer', model);

    expect(result.totalMarks).toBe(7.5);
    // The retry is visible in the audit trail rather than hidden.
    expect(result.audit.some((event) => event.kind === 'model_retry')).toBe(true);
  });
});

/* ========================================================================== *
 * Required case 8 — a score that would exceed the maximum
 * ========================================================================== */

describe('a model that awards more marks than exist', () => {
  it('clamps every criterion into range and recomputes the total', async () => {
    const { result } = await grade('student-answer', new OverscoringGradingModel(3));

    // Each question: one criterion forced negative (clamped to 0) and four
    // awarded triple (clamped to their maximum of 1) — so 4 of 5, not 15 of 5.
    expect(result.totalMarks).toBe(12);
    expect(result.totalMarks).toBeLessThanOrEqual(result.maxMarks);

    for (const question of result.questions) {
      expect(question.awardedMarks).toBe(4);
      for (const criterion of question.criteria) {
        expect(criterion.awardedMarks).toBeLessThanOrEqual(criterion.maxMarks);
        expect(criterion.awardedMarks).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('records each correction in the audit trail', async () => {
    const { result } = await grade('student-answer', new OverscoringGradingModel(3));

    const above = result.audit.filter((event) => event.kind === 'clamped_above_max');
    const below = result.audit.filter((event) => event.kind === 'clamped_below_zero');

    expect(above).toHaveLength(12); // four per question
    expect(below).toHaveLength(3); // one per question
    expect(above[0]?.before).toBe(3);
    expect(above[0]?.after).toBe(1);

    // The total was derived, not taken from the model.
    expect(result.audit.some((event) => event.kind === 'total_recomputed')).toBe(true);
  });

  it('flags the paper for review, because silently corrected marks are not trustworthy', async () => {
    const { result } = await grade('student-answer', new OverscoringGradingModel(3));

    expect(result.requiresHumanReview).toBe(true);
    expect(result.reviewReasons.join(' ')).toMatch(/outside the permitted range/i);
  });
});

/* ========================================================================== *
 * Fabricated evidence — the "feedback must be supported by evidence" rule
 * ========================================================================== */

describe('a model that cites evidence which is not in the answer', () => {
  it('marks the citation unverified rather than showing it as fact', async () => {
    const { result } = await grade('student-answer', new FabricatedEvidenceGradingModel());

    const cited = result.questions
      .flatMap((question) => question.criteria)
      .filter((criterion) => criterion.evidence !== null);

    expect(cited.length).toBeGreaterThan(0);
    expect(cited.every((criterion) => criterion.evidence!.verified === false)).toBe(true);
    expect(result.audit.filter((event) => event.kind === 'evidence_unverified').length).toBeGreaterThan(0);
  });

  it('refuses to draw annotations from a quote that does not exist', async () => {
    const { annotations } = await grade('student-answer', new FabricatedEvidenceGradingModel());

    // Every finding this model produces is anchored to invented text, so none of
    // them should survive into annotations on the page.
    expect(annotations).toHaveLength(0);
  });

  it('collapses confidence and demands review', async () => {
    const { result } = await grade('student-answer', new FabricatedEvidenceGradingModel());

    expect(result.confidence).toBeLessThan(0.65);
    expect(result.requiresHumanReview).toBe(true);
    expect(result.reviewReasons.join(' ')).toMatch(/could not be found in the answer/i);
  });
});

/* ========================================================================== *
 * A rubric the demo grader does not know
 * ========================================================================== */

describe('an exam the built-in grader was not written for', () => {
  /** A rubric with this system's usual criterion ids but entirely different wording. */
  const historyRubric: Rubric = {
    id: 'history',
    title: 'History paper',
    totalMarks: 3,
    questions: [
      {
        id: 'q1',
        number: 1,
        subject: 'History',
        maxMarks: 3,
        prompt: 'Explain the consequences of the Treaty of Versailles.',
        modelAnswer: 'The treaty was signed in 1919 and imposed reparations on Germany.',
        guidance: [],
        requiresDiagram: false,
        criteriaSource: 'instructor',
        criteria: [
          { id: 'q1c1', description: 'States the treaty was signed in 1919', maxMarks: 1 },
          { id: 'q1c2', description: 'Identifies reparations imposed on Germany', maxMarks: 1 },
          { id: 'q1c3', description: 'Links the terms to Weimar economic hardship', maxMarks: 1 },
        ],
      },
    ],
  };

  /*
   * Every rubric this system extracts numbers its criteria q1c1, q1c2, … so an
   * id-only rule lookup applied the physics rules to any paper at all: a correct
   * history answer came back 0/3 with "the answer never establishes that the
   * circuit is a closed series path". A confident wrong mark is worse than an
   * honest refusal, so the mock now checks the criterion wording too.
   */
  it('refuses to mark it rather than applying another paper\'s rules', async () => {
    const { document, bytes } = await loadAnswerFixture('student-answer');

    await expect(
      runGrading({
        rubric: historyRubric,
        studentDocument: document,
        studentPdfBytes: bytes,
        model: new MockGradingModel(),
      }),
    ).rejects.toMatchObject({ code: 'provider_unsupported', retryable: false });
  });

  it('says why, and what to do about it', async () => {
    const { document, bytes } = await loadAnswerFixture('student-answer');

    await expect(
      runGrading({
        rubric: historyRubric,
        studentDocument: document,
        studentPdfBytes: bytes,
        model: new MockGradingModel(),
      }),
    ).rejects.toThrow(/only knows the sample paper/i);
  });
});

/* ========================================================================== *
 * A paper where only some questions have an instructor rubric
 * ========================================================================== */

describe('a paper mixing instructor and inferred criteria', () => {
  /**
   * Q1 and Q3 carry the instructor's own criteria; Q2's were inferred because
   * the scheme defined none. The point of the test is that one unrubricked
   * question changes nothing about the other two.
   */
  async function mixedRubric(): Promise<Rubric> {
    const base = await loadRubric();
    return {
      ...base,
      questions: base.questions.map((question) =>
        question.number === 2 ? { ...question, criteriaSource: 'ai-inferred' as const } : question,
      ),
    };
  }

  it('grades every question, including the inferred one', async () => {
    const { document, bytes } = await loadAnswerFixture('student-answer');
    const { result } = await runGrading({
      rubric: await mixedRubric(),
      studentDocument: document,
      studentPdfBytes: bytes,
      model: new MockGradingModel(),
    });

    // Requirement: a missing rubric on one question must never stop the rest.
    expect(result.questions).toHaveLength(3);
    expect(result.maxMarks).toBe(15);
  });

  it("leaves the instructor's questions marked exactly as before", async () => {
    const { document, bytes } = await loadAnswerFixture('student-answer');
    const { result } = await runGrading({
      rubric: await mixedRubric(),
      studentDocument: document,
      studentPdfBytes: bytes,
      model: new MockGradingModel(),
    });

    expect(questionByNumber(result, 1).awardedMarks).toBe(2.5);
    expect(questionByNumber(result, 3).awardedMarks).toBe(2);
  });

  it('records whose criteria produced each question, so the UI can say so', async () => {
    const { document, bytes } = await loadAnswerFixture('student-answer');
    const { result } = await runGrading({
      rubric: await mixedRubric(),
      studentDocument: document,
      studentPdfBytes: bytes,
      model: new MockGradingModel(),
    });

    expect(questionByNumber(result, 1).criteriaSource).toBe('instructor');
    expect(questionByNumber(result, 2).criteriaSource).toBe('ai-inferred');
    expect(questionByNumber(result, 3).criteriaSource).toBe('instructor');
  });

  /*
   * The demo grader has no rules for criteria it did not write, and refusing the
   * run over that would let one question sink the paper. It declines this
   * question and says why, while the rest grade normally.
   */
  it('declines only the inferred question when the grader cannot mark it', async () => {
    const { document, bytes } = await loadAnswerFixture('student-answer');
    const { result } = await runGrading({
      rubric: await mixedRubric(),
      studentDocument: document,
      studentPdfBytes: bytes,
      model: new MockGradingModel(),
    });

    const q2 = questionByNumber(result, 2);
    expect(q2.awardedMarks).toBe(0);
    expect(q2.criteria.every((criterion) => criterion.status === 'missing')).toBe(true);
    expect(q2.summary).toMatch(/not marked/i);
    expect(result.requiresHumanReview).toBe(true);
  });

  it('still satisfies every invariant', async () => {
    const { document, bytes } = await loadAnswerFixture('student-answer');
    const { result } = await runGrading({
      rubric: await mixedRubric(),
      studentDocument: document,
      studentPdfBytes: bytes,
      model: new MockGradingModel(),
    });

    expect(checkResultInvariants(result)).toEqual([]);
  });
});

/* ========================================================================== *
 * Invariants — these must hold for every paper and every provider
 * ========================================================================== */

describe('result invariants', () => {
  const slugs: AnswerSlug[] = ['student-answer', 'fully-correct', 'incorrect', 'blank', 'ocr-errors'];

  it.each(slugs)('hold for %s under the normal provider', async (slug) => {
    const { result } = await grade(slug);
    expect(checkResultInvariants(result)).toEqual([]);
  });

  it.each(slugs)('hold for %s under a model that overscores', async (slug) => {
    const { result } = await grade(slug, new OverscoringGradingModel(5));
    expect(checkResultInvariants(result)).toEqual([]);
  });

  it('keep the total equal to the sum of the rubric points', async () => {
    const { result } = await grade('student-answer');

    const questionSum = result.questions.reduce((total, question) => total + question.awardedMarks, 0);
    expect(result.totalMarks).toBeCloseTo(questionSum, 6);

    for (const question of result.questions) {
      const criteriaSum = question.criteria.reduce((total, criterion) => total + criterion.awardedMarks, 0);
      expect(question.awardedMarks).toBeCloseTo(criteriaSum, 6);
    }
  });

  it('account for every rubric criterion in the result', async () => {
    const { result } = await grade('student-answer');

    const expected = rubric.questions.flatMap((question) => question.criteria.map((c) => c.id)).sort();
    const actual = result.questions.flatMap((question) => question.criteria.map((c) => c.criterionId)).sort();

    expect(actual).toEqual(expected);
  });

  it('always report a confidence between 0 and 1', async () => {
    const { result } = await grade('student-answer');

    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    for (const question of result.questions) {
      expect(question.confidence).toBeGreaterThanOrEqual(0);
      expect(question.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('give a reason whenever review is demanded', async () => {
    for (const slug of slugs) {
      const { result } = await grade(slug);
      if (result.requiresHumanReview) {
        expect(result.reviewReasons.length, `${slug} flagged with no reason`).toBeGreaterThan(0);
      }
    }
  });
});
