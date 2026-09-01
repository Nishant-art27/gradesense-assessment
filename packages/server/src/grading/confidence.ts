/**
 * How confident the system is in a set of marks.
 *
 * This is arithmetic on observable facts, not the model's opinion of itself. The
 * model's self-reported certainty is one input, and it is *capped* by what we
 * actually managed to verify: if the grader cited three quotes and only one of
 * them exists in the answer, no amount of self-assurance should survive that.
 *
 * Keeping it deterministic has two payoffs. The number is explainable — every
 * deduction below comes back as a human-readable factor the UI can show — and it
 * is testable, because the same inputs always produce the same score.
 */

export interface ConfidenceInput {
  /** The model's own certainty, 0..1. */
  selfConfidence: number;
  /** Criteria whose judgement cited a quote. */
  quotedCriteria: number;
  /** Of those, how many quotes were actually found in the answer. */
  verifiedQuotes: number;
  /** Marks that had to be clamped into range. */
  clampEvents: number;
  /** Times the model had to be re-asked for valid output. */
  repairAttempts: number;
  /** Rubric criteria the model failed to return at all. */
  missingCriteria: number;
  /** Length of the answer text for this question. */
  answerChars: number;
  /** True when the answer sheet had no question headings to split on. */
  approximateSegmentation: boolean;
  /** Findings that could not be placed on the page. */
  unresolvedAnchors: number;
  /** Findings placed from a model-supplied region rather than a quote. */
  regionAnchors: number;
}

export interface ConfidenceResult {
  value: number;
  /** Plain-language reasons the score is not 1.0. Empty when nothing counted against it. */
  factors: string[];
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const factors: string[] = [];
  let value = clamp01(input.selfConfidence);

  // Verified evidence is the strongest signal available, so it scales the score
  // rather than subtracting from it. A grader whose citations do not check out
  // cannot rise above roughly 0.6 of its claimed confidence.
  if (input.quotedCriteria > 0) {
    const rate = input.verifiedQuotes / input.quotedCriteria;
    value *= 0.6 + 0.4 * rate;
    if (rate < 1) {
      const failed = input.quotedCriteria - input.verifiedQuotes;
      factors.push(
        `${failed} of ${input.quotedCriteria} cited quote${input.quotedCriteria === 1 ? '' : 's'} could not be found in the answer.`,
      );
    }
  } else {
    // No quotes at all is not necessarily wrong — every criterion may genuinely
    // be unaddressed — but it does mean nothing was corroborated.
    value *= 0.85;
    factors.push('No evidence quotes were cited, so no judgement could be corroborated against the answer.');
  }

  if (input.clampEvents > 0) {
    value -= Math.min(0.3, input.clampEvents * 0.1);
    factors.push(
      `${input.clampEvents} mark${input.clampEvents === 1 ? '' : 's'} fell outside the permitted range and had to be corrected.`,
    );
  }

  if (input.repairAttempts > 0) {
    value -= 0.15 * input.repairAttempts;
    factors.push(
      `The grader had to be re-asked ${input.repairAttempts} time${input.repairAttempts === 1 ? '' : 's'} before returning usable output.`,
    );
  }

  if (input.missingCriteria > 0) {
    value -= Math.min(0.4, input.missingCriteria * 0.12);
    factors.push(
      `${input.missingCriteria} rubric point${input.missingCriteria === 1 ? ' was' : 's were'} not returned by the grader and scored zero by default.`,
    );
  }

  // A very short answer gives a grader little to work with in either direction.
  if (input.answerChars > 0 && input.answerChars < 200) {
    value -= 0.1;
    factors.push('The answer is very short, so there is little text to judge.');
  }

  if (input.approximateSegmentation) {
    value -= 0.08;
    factors.push('The answer sheet had no question headings, so the answer boundaries are approximate.');
  }

  if (input.unresolvedAnchors > 0) {
    value -= Math.min(0.15, input.unresolvedAnchors * 0.04);
    factors.push(
      `${input.unresolvedAnchors} annotation${input.unresolvedAnchors === 1 ? '' : 's'} could not be placed on the page and became margin notes.`,
    );
  }

  if (input.regionAnchors > 0) {
    // Region anchors are approximate by nature. Small penalty, and worth saying
    // out loud so a teacher knows to check the position.
    value -= Math.min(0.1, input.regionAnchors * 0.03);
    factors.push(
      `${input.regionAnchors} annotation${input.regionAnchors === 1 ? ' was' : 's were'} placed from an approximate diagram region — check the position.`,
    );
  }

  return { value: Number(clamp01(value).toFixed(4)), factors };
}

/**
 * Combines per-question confidence into one figure for the paper.
 *
 * Weighted by marks available, so a shaky reading of a 5-mark question matters
 * more than a shaky reading of a 1-mark one. Uses the minimum as a floor guard:
 * a paper containing one question we barely understood should not look
 * comfortable because the other two were easy.
 */
export function combineConfidence(
  perQuestion: Array<{ confidence: number; maxMarks: number }>,
): number {
  if (perQuestion.length === 0) return 0;

  const totalWeight = perQuestion.reduce((sum, entry) => sum + entry.maxMarks, 0);
  if (totalWeight === 0) return 0;

  const weighted = perQuestion.reduce((sum, entry) => sum + entry.confidence * entry.maxMarks, 0) / totalWeight;
  const lowest = Math.min(...perQuestion.map((entry) => entry.confidence));

  // Pull the average toward the weakest question rather than letting it hide.
  return Number(clamp01(weighted * 0.75 + lowest * 0.25).toFixed(4));
}
