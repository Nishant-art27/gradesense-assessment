import type { FindingKind, ModelFinding, ModelQuestionGrading, PageText } from '@gradesense/shared';
import type {
  GradeQuestionInput,
  GradingModel,
  ModelAttemptContext,
  ModelResponse,
} from '../model.js';
import { AppError } from '../../errors.js';
import { findDiagramByCaption } from '../diagram.js';
import { findPhrase, normalise, sentenceAround, windowAround } from '../text-match.js';
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

/**
 * Finds the rule for a criterion.
 *
 * Both the id and the wording must agree. The id alone is not enough: every
 * rubric this system extracts numbers its criteria q1c1, q1c2, … so an id-only
 * lookup silently applies one paper's rules to a completely different exam.
 */
function findRule(criterion: { id: string; description: string }): MockRule | null {
  const rule = MOCK_RULES[criterion.id];
  if (!rule) return null;
  return normalise(rule.criterionDescription).norm === normalise(criterion.description).norm
    ? rule
    : null;
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
 * Measures the drawing the rule names, and falls back to the rule's declared
 * coordinates when it cannot be found — a student who drew a graph without
 * labelling anything still gets an annotation, just a rougher one.
 *
 * The measurement itself lives in `grading/diagram.ts` and is the same one the
 * live providers' regions are snapped to, so the mock and a real model put their
 * diagram annotations in exactly the same place.
 */
function resolveRegion(
  region: NonNullable<MockRule['missing']['diagramRegion']>,
  pages: PageText[],
  layout: { startPage: number; pageCount: number },
): Region {
  const measured = findDiagramByCaption(pages, region.caption);
  if (measured) {
    const { caption, ...box } = measured;
    return box;
  }

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

  // The mock only knows the paper its rules were written for. Refusing an
  // unfamiliar exam outright is the honest failure: marking a history answer
  // with physics rules produces a confident zero and nonsense feedback, which is
  // far worse for a teacher than being told the demo grader cannot help.
  /*
   * Criteria that were inferred rather than set by the instructor are, by
   * definition, ones no hand-written rule can know. Refusing the run over them
   * would let one unrubricked question stop the whole paper, so the demo grader
   * returns "not marked" for this question and the rest of the paper proceeds.
   */
  if (question.criteriaSource === 'ai-inferred') {
    return {
      questionId: question.id,
      criteria: question.criteria.map((criterion) => ({
        criterionId: criterion.id,
        awardedMarks: 0,
        status: 'missing' as const,
        evidenceQuote: null,
        reasoning:
          'These criteria were inferred rather than set by the instructor, so the demo grader has no rule for them. Mark this question by hand, or run with an API key.',
        correction: null,
      })),
      findings: [],
      summary: `Question ${question.number} was not marked: its criteria were inferred, and the demo grader only knows instructor-defined criteria.`,
      selfConfidence: 0,
    };
  }

  const recognised = question.criteria.filter((criterion) => findRule(criterion) !== null);
  if (recognised.length === 0) {
    throw new AppError(
      'provider_unsupported',
      'The built-in demo grader only knows the sample paper supplied with this assignment, so it cannot mark this exam.',
      {
        status: 501,
        retryable: false,
        details: [
          `No marking rules match question ${question.number} ("${question.subject}").`,
          'Set MODEL_PROVIDER=anthropic with an API key to mark your own papers.',
        ],
      },
    );
  }

  const criteria = question.criteria.map((criterion) => {
    const rule = findRule(criterion);
    if (!rule) {
      // No rule for this criterion — say so rather than inventing a mark. The
      // pipeline will treat a zero with low confidence as review-worthy.
      return {
        judgement: {
          criterionId: criterion.id,
          awardedMarks: 0,
          status: 'missing' as const,
          evidenceQuote: null,
          reasoning:
          'The demo grader has no rule for this criterion, so it was not marked. It needs a human, or a real model.',
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
