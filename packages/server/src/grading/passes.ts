import type { CriterionScore, Question } from '@gradesense/shared';
import type { ConfidenceDraft, ValidationSuccess } from './validate.js';

/**
 * Combining the marks from an answer that had to be graded in passages.
 *
 * Almost every answer is graded in one request. The exception is an answer to
 * a single question that is itself longer than the token budget allows — a
 * six-page derivation on a provider with an 8,000-token ceiling. Such an answer
 * is split at its sub-parts or paragraphs, each passage is graded against the
 * full rubric with the ordinary prompt, and the passes are combined here.
 *
 * The combination rule follows from what a rubric point means. A point is
 * earned if the student demonstrates it *somewhere* in the answer, so each
 * criterion takes the best-supported award any passage gave it, together with
 * that passage's evidence and reasoning. Nothing is ever added across passages,
 * so no criterion can exceed its maximum, and the total is recomputed from the
 * chosen awards. Findings are kept from every passage because each was verified
 * against the text it quotes. Confidence takes the least confident pass: the
 * grader never saw the whole answer at once, and the score should say so.
 */

export function mergePasses(question: Question, passes: ValidationSuccess[]): ValidationSuccess {
  if (passes.length === 0) throw new Error('mergePasses needs at least one pass');
  if (passes.length === 1) return passes[0]!;

  const first = passes[0]!;

  const criteria: CriterionScore[] = question.criteria.map((criterion) => {
    const candidates = passes
      .map((pass) => pass.result.criteria.find((score) => score.criterionId === criterion.id))
      .filter((score): score is CriterionScore => score !== undefined);

    // Highest award wins; among equals, the one whose evidence was verified.
    return candidates.reduce((best, score) => {
      if (score.awardedMarks > best.awardedMarks) return score;
      if (score.awardedMarks === best.awardedMarks && !best.evidence?.verified && score.evidence?.verified) return score;
      return best;
    }, candidates[0]!);
  });

  const awardedMarks = Number(criteria.reduce((total, score) => total + score.awardedMarks, 0).toFixed(4));

  const summaries = [...new Set(passes.map((pass) => pass.result.summary.trim()).filter((s) => s.length > 0))];
  const notes = [
    ...new Set(passes.flatMap((pass) => pass.result.notes)),
    `This answer was longer than one request to the grading model allows, so it was marked in ${passes.length} passages. Each rubric point carries the best-supported award across them; nothing was left out.`,
  ];

  const confidenceDraft: ConfidenceDraft = {
    selfConfidence: Math.min(...passes.map((pass) => pass.confidenceDraft.selfConfidence)),
    quotedCriteria: sum(passes, (draft) => draft.quotedCriteria),
    verifiedQuotes: sum(passes, (draft) => draft.verifiedQuotes),
    clampEvents: sum(passes, (draft) => draft.clampEvents),
    repairAttempts: Math.max(...passes.map((pass) => pass.confidenceDraft.repairAttempts)),
    // A criterion counts as missing only if no passage returned a judgement for it.
    missingCriteria: Math.min(...passes.map((pass) => pass.confidenceDraft.missingCriteria)),
    answerChars: sum(passes, (draft) => draft.answerChars),
    approximateSegmentation: passes.some((pass) => pass.confidenceDraft.approximateSegmentation),
  };

  return {
    ok: true,
    result: {
      ...first.result,
      awardedMarks,
      summary: summaries.join(' '),
      criteria,
      notes,
    },
    findings: passes.flatMap((pass) => pass.findings),
    audit: passes.flatMap((pass) => pass.audit),
    confidenceDraft,
  };
}

function sum(passes: ValidationSuccess[], pick: (draft: ConfidenceDraft) => number): number {
  return passes.reduce((total, pass) => total + pick(pass.confidenceDraft), 0);
}
