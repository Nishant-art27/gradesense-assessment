import Anthropic from '@anthropic-ai/sdk';
import type { GradeQuestionInput, GradingModel, ModelAttemptContext, ModelResponse } from '../model.js';
import { MockGradingModel } from './mock.js';

/**
 * Deliberately misbehaving providers.
 *
 * The brief asks for tests covering model failure, malformed output and scores
 * above the maximum. Those are properties of the *pipeline*, not of any model,
 * so the honest way to test them is to inject a provider that misbehaves in
 * exactly that way and assert the pipeline copes. Mocking at this seam means the
 * clamping, repair and retry code under test is the same code that runs in
 * production.
 */

/** Always fails with a retryable error, so the retry-then-503 path can be tested. */
export class FailingGradingModel implements GradingModel {
  readonly providerName = 'failing';
  readonly modelName = 'always-fails';

  attempts = 0;

  constructor(private readonly kind: 'rate_limit' | 'server' | 'connection' = 'server') {}

  async gradeQuestion(_input: GradeQuestionInput, _context: ModelAttemptContext): Promise<ModelResponse> {
    this.attempts += 1;

    if (this.kind === 'rate_limit') {
      throw new Anthropic.RateLimitError(429, { type: 'error' }, 'Rate limit exceeded', new Headers());
    }
    if (this.kind === 'connection') {
      throw new Anthropic.APIConnectionError({ message: 'socket hang up' });
    }
    throw new Anthropic.InternalServerError(503, { type: 'error' }, 'Upstream unavailable', new Headers());
  }
}

/**
 * Rejects the credentials, the way a live provider does with a key that is
 * missing, mistyped or expired.
 *
 * The error deliberately carries a whole JSON body as its message, because that
 * is exactly what the Google and Anthropic SDKs do — and passing that body
 * through to the browser was the bug this guards.
 */
export class UnauthorisedGradingModel implements GradingModel {
  readonly providerName = 'gemini';
  readonly modelName = 'needs-a-key';

  attempts = 0;

  constructor(private readonly status: 401 | 403 = 401) {}

  private reject(): never {
    this.attempts += 1;
    const body = {
      error: {
        code: this.status,
        message:
          'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.',
        status: 'UNAUTHENTICATED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'ACCESS_TOKEN_TYPE_UNSUPPORTED',
            metadata: { service: 'generativelanguage.googleapis.com' },
          },
        ],
      },
    };
    const error = new Error(JSON.stringify(body)) as Error & { status: number };
    error.status = this.status;
    throw error;
  }

  async gradeQuestion(_input: GradeQuestionInput, _context: ModelAttemptContext): Promise<ModelResponse> {
    this.reject();
  }

  async extractRubric(): Promise<ModelResponse> {
    this.reject();
  }
}

/**
 * Returns unusable output.
 *
 * `mode: 'always'` never recovers, which should end as an unrecoverable-output
 * result rather than an exception. `mode: 'then-valid'` fails once and then
 * behaves, which exercises the repair retry.
 */
export class MalformedGradingModel implements GradingModel {
  readonly providerName = 'malformed';
  readonly modelName = 'returns-garbage';

  attempts = 0;
  private readonly fallback = new MockGradingModel();

  constructor(
    private readonly mode: 'always' | 'then-valid' = 'always',
    private readonly shape: 'not-json' | 'wrong-shape' | 'truncated' = 'wrong-shape',
  ) {}

  async gradeQuestion(input: GradeQuestionInput, context: ModelAttemptContext): Promise<ModelResponse> {
    this.attempts += 1;

    if (this.mode === 'then-valid' && context.repair) {
      return this.fallback.gradeQuestion(input, context);
    }

    if (this.shape === 'not-json') {
      return { data: null, raw: 'Sure! Here are the marks for this question: full credit, well done.' };
    }

    if (this.shape === 'truncated') {
      return {
        data: null,
        raw: `{"questionId":"${input.question.id}","criteria":[{"criterionId":"${input.question.criteria[0]?.id ?? 'x'}","awardedMarks":1,`,
      };
    }

    // Structurally valid JSON that violates the schema in several ways at once:
    // criteria is not an array, selfConfidence is a string, findings is absent.
    return {
      data: {
        questionId: input.question.id,
        criteria: 'all of them were fine',
        summary: 42,
        selfConfidence: 'very high',
      },
      raw: '{"questionId":"...","criteria":"all of them were fine","summary":42,"selfConfidence":"very high"}',
    };
  }
}

/**
 * Awards more marks than exist, and reports statuses inconsistent with them.
 * The pipeline must clamp every criterion, recompute the total, and record the
 * correction in the audit trail.
 */
export class OverscoringGradingModel implements GradingModel {
  readonly providerName = 'overscoring';
  readonly modelName = 'awards-too-much';

  constructor(private readonly multiplier = 3) {}

  async gradeQuestion(input: GradeQuestionInput, _context: ModelAttemptContext): Promise<ModelResponse> {
    const grading = {
      questionId: input.question.id,
      criteria: input.question.criteria.map((criterion, index) => ({
        criterionId: criterion.id,
        // Every criterion is over its own maximum, and one is negative, so both
        // clamp directions get exercised in a single run.
        awardedMarks: index === 0 ? -2 : criterion.maxMarks * this.multiplier,
        status: 'correct' as const,
        evidenceQuote: null,
        reasoning: 'Awarded generously by a model that ignores the stated maximum.',
        correction: null,
      })),
      findings: [],
      summary: 'This model believes the student did better than the paper allows.',
      selfConfidence: 0.99,
    };

    return { data: grading, raw: JSON.stringify(grading) };
  }
}

/**
 * Cites evidence that does not appear anywhere in the student's answer.
 * The pipeline must refuse to build annotations from it and must lower
 * confidence rather than presenting a fabricated quote to a teacher.
 */
export class FabricatedEvidenceGradingModel implements GradingModel {
  readonly providerName = 'fabricated-evidence';
  readonly modelName = 'invents-quotes';

  async gradeQuestion(input: GradeQuestionInput, _context: ModelAttemptContext): Promise<ModelResponse> {
    const invented = 'The student wrote a beautifully reasoned paragraph about quantum tunnelling here.';

    const grading = {
      questionId: input.question.id,
      criteria: input.question.criteria.map((criterion) => ({
        criterionId: criterion.id,
        awardedMarks: 0,
        status: 'incorrect' as const,
        evidenceQuote: invented,
        reasoning: 'Deducted on the basis of a quote that was never in the answer.',
        correction: 'Something else entirely.',
      })),
      findings: input.question.criteria.map((criterion) => ({
        criterionId: criterion.id,
        kind: 'incorrect' as const,
        quote: invented,
        region: null,
        comment: 'This annotation is anchored to text that does not exist.',
        correction: null,
        severity: 'major' as const,
      })),
      summary: 'Every judgement here rests on a fabricated quote.',
      selfConfidence: 0.95,
    };

    return { data: grading, raw: JSON.stringify(grading) };
  }
}

/** Fails a fixed number of times, then succeeds — for testing backoff recovery. */
export class FlakyGradingModel implements GradingModel {
  readonly providerName = 'flaky';
  readonly modelName = 'fails-then-works';

  attempts = 0;
  private readonly fallback = new MockGradingModel();

  constructor(private readonly failuresBeforeSuccess = 1) {}

  async gradeQuestion(input: GradeQuestionInput, context: ModelAttemptContext): Promise<ModelResponse> {
    this.attempts += 1;
    if (this.attempts <= this.failuresBeforeSuccess) {
      throw new Anthropic.InternalServerError(500, { type: 'error' }, 'Transient upstream error', new Headers());
    }
    return this.fallback.gradeQuestion(input, context);
  }
}
