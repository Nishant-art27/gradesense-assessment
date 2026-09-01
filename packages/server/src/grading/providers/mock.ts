import type { FindingKind, ModelFinding, ModelQuestionGrading, PageText } from '@gradesense/shared';
import type {
  GradeQuestionInput,
  GradingModel,
  ModelAttemptContext,
  ModelResponse,
} from '../model.js';
import { findPhrase, sentenceAround, windowAround } from '../text-match.js';
import { MOCK_RULES, SURFACE_ERRORS, type MockRule, type Matcher } from './mock-rules.js';

/**
 * The default grading provider.
 *
 * This is a small rule-based examiner, not a table of canned responses keyed on
 * filename. That distinction matters: a lookup table would make every test pass
 * without the pipeline doing anything, whereas this actually reads the answer
 * text, matches phrases fuzzily enough to survive OCR damage, and quotes the
 * student verbatim — so the clamping, evidence-verification, anchoring and
 * confidence layers all get exercised on real input.
 *
 * It is obviously not as good as the real model. It does not need to be. It
 * needs to be *deterministic*, so that a reviewer with no API key can run the
 * app and the whole suite, and so that a failing test means the pipeline broke
 * rather than that a model changed its mind.
 */
export class MockGradingModel implements GradingModel {
  readonly providerName = 'mock';
  readonly modelName = 'rule-based-mock';

  /** Counts calls, so a test can assert the blank path never reached a model. */
  callCount = 0;

  async gradeQuestion(input: GradeQuestionInput, _context: ModelAttemptContext): Promise<ModelResponse> {
    this.callCount += 1;
    const grading = gradeWithRules(input);
    return { data: grading, raw: JSON.stringify(grading) };
  }
}

function match(text: string, matcher: Matcher): { text: string; start: number; end: number } | null {
  if (matcher instanceof RegExp) {
    // Raw regex matching, for things normalisation would erase — notably the
    // difference between "V = IR" and "V = I/R", which both normalise to the
    // same token sequence once punctuation is stripped.
    const found = matcher.exec(text);
    if (!found) return null;
    return { text: found[0], start: found.index, end: found.index + found[0].length };
  }

  const found = findPhrase(text, matcher, 0.82);
  if (!found) return null;
  return { text: found.text, start: found.start, end: found.end };
}

function firstMatch(text: string, matchers: Matcher[]): { text: string; start: number; end: number } | null {
  for (const matcher of matchers) {
    const found = match(text, matcher);
    if (found) return found;
  }
  return null;
}

interface CriterionOutcome {
  awardedMarks: number;
  status: 'correct' | 'partial' | 'missing' | 'incorrect';
  evidenceQuote: string | null;
  reasoning: string;
  correction: string | null;
  finding: ModelFinding | null;
}

/**
 * Resolves one criterion against the answer text.
 *
 * Order matters and encodes a marking philosophy: a substantive error is checked
 * before credit, credit is checked before a downgrade, and an inadequate attempt
 * is distinguished from no attempt at all — so "Some people say that technology
 * is helpful." earns an anchored annotation rather than a bare "missing".
 */
function resolveCriterion(
  rule: MockRule,
  text: string,
  maxMarks: number,
  layout: { startPage: number; pageCount: number; pages: PageText[] },
): CriterionOutcome {
  // 1. Substantive error.
  for (const fault of rule.faults) {
    const found = match(text, fault.match);
    if (found) {
      const quote = sentenceAround(text, found.start, found.end);
      return {
        awardedMarks: 0,
        status: 'incorrect',
        evidenceQuote: quote,
        reasoning: fault.comment,
        correction: fault.correction,
        finding: {
          criterionId: rule.criterionId,
          kind: 'incorrect',
          quote,
          region: null,
          comment: fault.comment,
          correction: fault.correction,
          severity: 'major',
        },
      };
    }
  }

  // 2. Credit.
  const awarded = firstMatch(text, rule.awards);
  if (awarded) {
    const quote = sentenceAround(text, awarded.start, awarded.end);

    // 3. Downgrade when the substance is right but something specific is wrong.
    for (const partial of rule.partials) {
      const found = match(text, partial.match);
      if (found) {
        const partialQuote = windowAround(text, found.start, found.end, 6);
        return {
          awardedMarks: maxMarks / 2,
          status: 'partial',
          evidenceQuote: quote,
          reasoning: partial.comment,
          correction: partial.correction,
          finding: {
            criterionId: rule.criterionId,
            kind: 'incorrect',
            quote: partialQuote,
            region: null,
            comment: partial.comment,
            correction: partial.correction,
            severity: 'minor',
          },
        };
      }
    }

    return {
      awardedMarks: maxMarks,
      status: 'correct',
      evidenceQuote: quote,
      reasoning: rule.awardReasoning,
      correction: null,
      finding: rule.praise
        ? {
            criterionId: rule.criterionId,
            kind: 'praise',
            quote,
            region: null,
            comment: rule.praise,
            correction: null,
            severity: 'minor',
          }
        : null,
    };
  }

  // 4. Attempted but inadequate.
  for (const weak of rule.weak) {
    const found = match(text, weak.match);
    if (found) {
      const quote = sentenceAround(text, found.start, found.end);
      return {
        awardedMarks: 0,
        status: 'incorrect',
        evidenceQuote: quote,
        reasoning: weak.comment,
        correction: weak.correction,
        finding: {
          criterionId: rule.criterionId,
          kind: 'incorrect',
          quote,
          region: null,
          comment: weak.comment,
          correction: weak.correction,
          severity: 'major',
        },
      };
    }
  }

  // 5. Never addressed. No quote — there is nothing to point at, so this
  //    becomes a margin note unless the rule names a diagram region.
  return {
    awardedMarks: 0,
    status: 'missing',
    evidenceQuote: null,
    reasoning: rule.missing.comment,
    correction: rule.missing.correction,
    finding: {
      criterionId: rule.criterionId,
      kind: 'missing',
      quote: null,
      region: rule.missing.diagramRegion
        ? resolveRegion(rule.missing.diagramRegion, layout.pages, layout)
        : null,
      comment: rule.missing.comment,
      correction: rule.missing.correction,
      severity: 'major',
    },
  };
}

type Region = { page: number; x: number; y: number; width: number; height: number };

/**
 * A drawing's caption and its own labels are text, and text has coordinates. So
 * the extent of a diagram can be measured rather than guessed: find the caption,
 * then take the bounding box of it and every label that follows before the next
 * answer begins.
 *
 * Guessing was measurably wrong. The hardcoded box for the circuit started below
 * its caption and ended inside the English answer on the next question — it both
 * missed the thing it pointed at and defaced something unrelated.
 */
function measureDiagramFromLabels(pages: PageText[], caption: string): Region | null {
  for (const page of pages) {
    const captionIndex = page.runs.findIndex(
      (run) => run.text.trim().toLowerCase() === caption.toLowerCase(),
    );
    if (captionIndex === -1) continue;

    const parts = [page.runs[captionIndex]!.rect];

    for (let i = captionIndex + 1; i < page.runs.length; i += 1) {
      const run = page.runs[i]!;
      const text = run.text.trim();
      if (text.length === 0) continue;
      // The next question's heading ends the diagram.
      if (/^Answer\s+\d/i.test(text)) break;
      // Body prose runs the width of the page; diagram labels are short. A wide
      // run means the drawing is over and normal text has resumed.
      if (run.rect.width > 0.3) break;
      parts.push(run.rect);
    }

    // A caption on its own tells us nothing about the drawing's extent.
    if (parts.length < 2) continue;

    const left = Math.min(...parts.map((rect) => rect.x));
    const right = Math.max(...parts.map((rect) => rect.x + rect.width));
    const top = Math.min(...parts.map((rect) => rect.y));
    const bottom = Math.max(...parts.map((rect) => rect.y + rect.height));

    // A little padding so the box frames the drawing instead of clipping it.
    const pad = 0.012;
    const x = Math.max(0, left - pad);
    const y = Math.max(0, top - pad);

    return {
      page: page.index,
      x,
      y,
      width: Math.min(1 - x, right - left + pad * 2),
      height: Math.min(1 - y, bottom - top + pad * 2),
    };
  }

  return null;
}

/**
 * Measures the diagram where possible, and falls back to the rule's declared
 * coordinates when the caption is missing — a student who drew a graph without
 * labelling it still gets an annotation, just a rougher one.
 */
function resolveRegion(
  region: NonNullable<MockRule['missing']['diagramRegion']>,
  pages: PageText[],
  layout: { startPage: number; pageCount: number },
): Region {
  const measured = measureDiagramFromLabels(pages, region.caption);
  if (measured) return measured;

  const { on, ...box } = region.fallback;
  const page = on === 'document-end' ? Math.max(0, layout.pageCount - 1) : layout.startPage;
  return { ...box, page };
}

/** Spelling and grammar findings. These annotate, but never deduct marks. */
function surfaceFindings(text: string, limit = 6): ModelFinding[] {
  const findings: ModelFinding[] = [];

  for (const error of SURFACE_ERRORS) {
    if (findings.length >= limit) break;
    const index = text.indexOf(error.wrong);
    if (index === -1) continue;

    findings.push({
      criterionId: null,
      kind: error.kind,
      // A six-letter word is too generic to anchor safely, so quote around it.
      quote: windowAround(text, index, index + error.wrong.length, 4),
      region: null,
      comment: `"${error.wrong}" should be "${error.right}".`,
      correction: error.right,
      severity: 'minor',
    });
  }

  return findings;
}

function gradeWithRules(input: GradeQuestionInput): ModelQuestionGrading {
  const { question, answerText, startPage, pageCount, pages } = input;
  const layout = { startPage, pageCount, pages };

  const criteria = question.criteria.map((criterion) => {
    const rule = MOCK_RULES[criterion.id];
    if (!rule) {
      // No rule for this criterion — say so rather than inventing a mark. The
      // pipeline will treat a zero with low confidence as review-worthy.
      return {
        judgement: {
          criterionId: criterion.id,
          awardedMarks: 0,
          status: 'missing' as const,
          evidenceQuote: null,
          reasoning: 'The mock grader has no rule for this criterion, so it cannot be marked automatically.',
          correction: null,
        },
        finding: null as ModelFinding | null,
      };
    }

    const outcome = resolveCriterion(rule, answerText, criterion.maxMarks, layout);
    return {
      judgement: {
        criterionId: criterion.id,
        awardedMarks: outcome.awardedMarks,
        status: outcome.status,
        evidenceQuote: outcome.evidenceQuote,
        reasoning: outcome.reasoning,
        correction: outcome.correction,
      },
      finding: outcome.finding,
    };
  });

  const findings = [
    ...criteria.map((entry) => entry.finding).filter((finding): finding is ModelFinding => finding !== null),
    ...surfaceFindings(answerText),
  ];

  const earned = criteria.reduce((total, entry) => total + entry.judgement.awardedMarks, 0);
  const unmatched = criteria.filter((entry) => entry.judgement.status === 'missing').length;

  return {
    questionId: question.id,
    criteria: criteria.map((entry) => entry.judgement),
    findings,
    summary: buildSummary(question.number, earned, question.maxMarks, criteria.map((c) => c.judgement.status)),
    // Confidence falls as more criteria go unmatched, because an unmatched
    // criterion is exactly the case where a rule-based grader is least reliable.
    selfConfidence: Number(Math.max(0.35, 0.92 - unmatched * 0.12).toFixed(2)),
  };
}

function buildSummary(
  number: number,
  earned: number,
  max: number,
  statuses: Array<'correct' | 'partial' | 'missing' | 'incorrect'>,
): string {
  const correct = statuses.filter((status) => status === 'correct').length;
  const wrong = statuses.filter((status) => status === 'incorrect').length;
  const absent = statuses.filter((status) => status === 'missing').length;

  const parts = [`Question ${number}: ${earned} of ${max} marks.`];
  if (correct > 0) parts.push(`${correct} rubric point${correct === 1 ? '' : 's'} fully met.`);
  if (wrong > 0) parts.push(`${wrong} contain${wrong === 1 ? 's' : ''} a substantive error.`);
  if (absent > 0) parts.push(`${absent} not addressed.`);

  return parts.join(' ');
}

export type { FindingKind };
