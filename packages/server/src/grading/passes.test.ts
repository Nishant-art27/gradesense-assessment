import { describe, expect, it } from 'vitest';
import type { CriterionScore, Question } from '@gradesense/shared';
import { mergePasses } from './passes.js';
import type { ValidationSuccess } from './validate.js';

const question: Question = {
  id: 'q33',
  number: 33,
  subject: 'Physics',
  prompt: 'State Faraday\'s law; derive L for a solenoid; find the emf in a rotating rod.',
  maxMarks: 5,
  modelAnswer: '',
  guidance: [],
  requiresDiagram: false,
  criteriaSource: 'instructor',
  criteria: [
    { id: 'q33c1', description: "Stating Faraday's law", maxMarks: 1 },
    { id: 'q33c2', description: 'Deriving L = μ0 n² A l', maxMarks: 2 },
    { id: 'q33c3', description: 'Finding the induced emf', maxMarks: 2 },
  ],
};

function score(criterionId: string, awardedMarks: number, verified: boolean | null): CriterionScore {
  const criterion = question.criteria.find((c) => c.id === criterionId)!;
  return {
    criterionId,
    description: criterion.description,
    maxMarks: criterion.maxMarks,
    awardedMarks,
    status: awardedMarks === criterion.maxMarks ? 'correct' : awardedMarks === 0 ? 'missing' : 'partial',
    reasoning: `reasoning for ${criterionId} at ${awardedMarks}`,
    correction: null,
    evidence:
      verified === null
        ? null
        : { quote: `quote ${criterionId}`, matchedText: null, verified, similarity: verified ? 1 : 0, rects: [] },
  };
}

function pass(scores: CriterionScore[], selfConfidence: number, summary: string): ValidationSuccess {
  return {
    ok: true,
    result: {
      questionId: 'q33',
      number: 33,
      subject: 'Physics',
      state: 'graded',
      criteriaSource: 'instructor',
      guidanceProvided: false,
      awardedMarks: scores.reduce((t, s) => t + s.awardedMarks, 0),
      maxMarks: 5,
      summary,
      criteria: scores,
      confidence: 0,
      notes: [],
    },
    findings: [{ criterionId: scores[0]!.criterionId, kind: 'incorrect', quote: 'q', region: null, comment: summary, correction: null, severity: 'minor' }],
    audit: [],
    confidenceDraft: {
      selfConfidence,
      quotedCriteria: scores.filter((s) => s.evidence).length,
      verifiedQuotes: scores.filter((s) => s.evidence?.verified).length,
      clampEvents: 0,
      repairAttempts: 0,
      missingCriteria: scores.filter((s) => s.status === 'missing').length,
      answerChars: 1000,
      approximateSegmentation: false,
    },
  };
}

describe('mergePasses', () => {
  it('returns a single pass untouched', () => {
    const only = pass([score('q33c1', 1, true), score('q33c2', 2, true), score('q33c3', 2, true)], 0.9, 'all good');
    expect(mergePasses(question, [only])).toBe(only);
  });

  it('gives each criterion its best-supported award and never adds across passes', () => {
    // Passage 1 held the law and the derivation; passage 2 held the numerical.
    const first = pass([score('q33c1', 1, true), score('q33c2', 2, true), score('q33c3', 0, null)], 0.85, 'Law and derivation correct.');
    const second = pass([score('q33c1', 0, null), score('q33c2', 0.5, false), score('q33c3', 1.5, true)], 0.7, 'Numerical has a unit slip.');

    const merged = mergePasses(question, [first, second]);

    expect(merged.result.criteria.map((c) => c.awardedMarks)).toEqual([1, 2, 1.5]);
    expect(merged.result.awardedMarks).toBe(4.5);
    // The chosen judgement brings its own evidence and reasoning with it.
    expect(merged.result.criteria[2]!.reasoning).toBe('reasoning for q33c3 at 1.5');
    expect(merged.result.criteria[2]!.evidence?.verified).toBe(true);
    // No criterion can exceed its maximum, because nothing is summed.
    merged.result.criteria.forEach((c) => expect(c.awardedMarks).toBeLessThanOrEqual(c.maxMarks));
  });

  it('prefers verified evidence when awards tie', () => {
    const unverified = pass([score('q33c1', 1, false), score('q33c2', 0, null), score('q33c3', 0, null)], 0.8, 'a');
    const verified = pass([score('q33c1', 1, true), score('q33c2', 0, null), score('q33c3', 0, null)], 0.8, 'b');

    const merged = mergePasses(question, [unverified, verified]);
    expect(merged.result.criteria[0]!.evidence?.verified).toBe(true);
  });

  it('keeps every finding, takes the lowest confidence, and says what happened', () => {
    const first = pass([score('q33c1', 1, true), score('q33c2', 2, true), score('q33c3', 0, null)], 0.9, 'First.');
    const second = pass([score('q33c1', 0, null), score('q33c2', 0, null), score('q33c3', 2, true)], 0.6, 'Second.');

    const merged = mergePasses(question, [first, second]);

    expect(merged.findings).toHaveLength(2);
    expect(merged.confidenceDraft.selfConfidence).toBe(0.6);
    expect(merged.confidenceDraft.quotedCriteria).toBe(3);
    expect(merged.confidenceDraft.verifiedQuotes).toBe(3);
    expect(merged.confidenceDraft.answerChars).toBe(2000);
    expect(merged.result.summary).toBe('First. Second.');
    expect(merged.result.notes.at(-1)).toMatch(/marked in 2 passages/);
  });
});
