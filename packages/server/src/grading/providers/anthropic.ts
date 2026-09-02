import Anthropic from '@anthropic-ai/sdk';
import {
  RUBRIC_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  buildQuestionPrompt,
  buildRepairPrompt,
  buildRubricPrompt,
  type GradeQuestionInput,
  type GradingModel,
  type ModelAttemptContext,
  type CriteriaInferenceInput,
  type ModelResponse,
  type RubricExtractionInput,
} from '../model.js';
import { QUESTION_GRADING_JSON_SCHEMA, RUBRIC_JSON_SCHEMA } from '../output-schema.js';
import { AppError } from '../../errors.js';
import { safeJsonParse } from './json.js';

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

  /**
   * Reads a rubric out of a marking scheme whose layout the structural parser
   * could not handle. Text-only: a marking scheme's content is its words, and
   * sending the PDF as well would cost tokens for no extra signal.
   */
  async extractRubric(input: RubricExtractionInput): Promise<ModelResponse> {
    const response = await this.client.messages.create({
      model: this.modelName,
      max_tokens: 16_000,
      system: [{ type: 'text', text: RUBRIC_SYSTEM_PROMPT }],
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: RUBRIC_JSON_SCHEMA },
      },
      messages: [{ role: 'user', content: buildRubricPrompt(input) }],
    });

    if (response.stop_reason === 'refusal') {
      throw new AppError('model_output_invalid', 'The model declined to read this marking scheme.', {
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

    return { data: safeJsonParse(raw), raw };
  }

  /** Derives criteria for a question whose scheme defined none. */
  async inferCriteria(input: CriteriaInferenceInput): Promise<ModelResponse> {
    const response = await this.client.messages.create({
      model: this.modelName,
      max_tokens: 8_000,
      system: [{ type: 'text', text: input.systemPrompt }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: input.schema } },
      messages: [{ role: 'user', content: input.prompt }],
    });

    const raw = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    return { data: safeJsonParse(raw), raw };
  }
}
