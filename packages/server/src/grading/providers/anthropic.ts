import Anthropic from '@anthropic-ai/sdk';
import {
  SYSTEM_PROMPT,
  buildQuestionPrompt,
  buildRepairPrompt,
  type GradeQuestionInput,
  type GradingModel,
  type ModelAttemptContext,
  type ModelResponse,
} from '../model.js';
import { QUESTION_GRADING_JSON_SCHEMA } from '../output-schema.js';
import { AppError } from '../../errors.js';

/**
 * The real grading model.
 *
 * Notable choices:
 *
 * - The student's whole answer sheet goes along as a PDF document block, so the
 *   model can see diagrams and layout rather than only the text layer. That is
 *   what makes the diagram criteria gradeable at all.
 * - The system prompt and the document block are identical across all three
 *   question calls and are marked for caching; only the question-specific text
 *   varies and it comes last. So marking a three-question paper pays for the
 *   document once, not three times.
 * - Nothing here validates the response. It hands back parsed JSON and the raw
 *   text, and the pipeline decides whether it is acceptable.
 */
export class AnthropicGradingModel implements GradingModel {
  readonly providerName = 'anthropic';
  readonly modelName: string;

  private readonly client: Anthropic;

  constructor(modelName: string, client?: Anthropic) {
    this.modelName = modelName;
    // A bare constructor resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or a
    // stored CLI profile — so this works for more setups than a key alone.
    this.client = client ?? new Anthropic({ maxRetries: 0 });
  }

  async gradeQuestion(input: GradeQuestionInput, context: ModelAttemptContext): Promise<ModelResponse> {
    const content: Anthropic.ContentBlockParam[] = [];

    if (input.pdfBase64) {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: input.pdfBase64 },
        // Cache breakpoint: everything above this is identical between questions.
        cache_control: { type: 'ephemeral' },
      });
    }

    content.push({ type: 'text', text: buildQuestionPrompt(input) });

    if (context.repair) {
      content.push({
        type: 'text',
        text: buildRepairPrompt(context.repair.rawResponse, context.repair.validationErrors),
      });
    }

    const response = await this.client.messages.create({
      model: this.modelName,
      max_tokens: 16_000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: QUESTION_GRADING_JSON_SCHEMA },
      },
      messages: [{ role: 'user', content }],
    });

    // A safety decline is not a transient failure and must not be retried as
    // one. Surfaced as a hard error so it reaches the review flag honestly.
    if (response.stop_reason === 'refusal') {
      throw new AppError('model_output_invalid', 'The model declined to mark this answer.', {
        status: 502,
        retryable: false,
        details: [response.stop_details?.explanation ?? 'No explanation given.'],
      });
    }

    const raw = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (response.stop_reason === 'max_tokens') {
      // Truncated JSON will fail validation; say why so the audit trail is clear.
      return { data: null, raw: `${raw}\n\n[response truncated: hit max_tokens]` };
    }

    return { data: safeJsonParse(raw), raw };
  }
}

function safeJsonParse(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Structured outputs should make this unreachable, but a model that wraps
    // its JSON in prose should still be recoverable rather than a hard failure.
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Whether a failure is worth retrying.
 *
 * Rate limits, connection drops and 5xx responses are transient. A bad request
 * or a bad key will fail identically forever, so retrying only delays an honest
 * error.
 */
export function isTransientModelError(error: unknown): boolean {
  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.InternalServerError) return true;
  if (error instanceof Anthropic.APIError) {
    return typeof error.status === 'number' && error.status >= 500;
  }
  // Anything that is not an SDK error at all — a socket hang-up, an aborted
  // fetch — is treated as transient.
  return error instanceof Error && !(error instanceof AppError);
}
