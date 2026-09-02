import Groq from 'groq-sdk';
import {
  RUBRIC_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  buildQuestionPrompt,
  buildRepairPrompt,
  buildRubricPrompt,
  type CriteriaInferenceInput,
  type GradeQuestionInput,
  type GradingModel,
  type ModelAttemptContext,
  type ModelResponse,
  type RubricExtractionInput,
} from '../model.js';
import { QUESTION_GRADING_JSON_SCHEMA, RUBRIC_JSON_SCHEMA } from '../output-schema.js';
import { AppError } from '../../errors.js';
import { safeJsonParse } from './json.js';

/**
 * Grading through Groq.
 *
 * Same prompts, same JSON schemas, same clamping and evidence checks as the
 * other two providers — only the transport differs, which is the point of the
 * `GradingModel` seam. What is genuinely different here is worth stating twice
 * rather than discovering later:
 *
 *  1. **Groq cannot be handed the answer sheet.** Gemini and Anthropic take the
 *     student's PDF inline and can look at the circuit and the graph. Groq's
 *     chat API takes text. So `pdfBase64` is deliberately ignored, and
 *     `buildQuestionPrompt` tells the model it is working from extracted text
 *     and must not describe a drawing it has not seen. Diagram criteria are
 *     still marked — from the labels and the student's own prose — but with the
 *     model's own confidence lowered, which flows into the review flag.
 *
 *  2. **The schema goes across untouched.** Groq's strict mode wants exactly
 *     what `output-schema.ts` already produces: every property required, and
 *     `additionalProperties: false` on every object. There is no adapter here
 *     and there should not be one — `groq.test.ts` asserts the schema satisfies
 *     strict mode instead, so a drift shows up as a failing test rather than a
 *     400 on every request once a key is present.
 *
 * The API is OpenAI-shaped, so this file is also the template for any
 * OpenAI-compatible vendor.
 */

/** Enough for a full question's judgement plus findings, with headroom. */
const MAX_COMPLETION_TOKENS = 16_000;
/** Marking is a reasoning task: the same answer should get the same marks twice. */
const TEMPERATURE = 0;

export class GroqGradingModel implements GradingModel {
  readonly providerName = 'groq';
  readonly modelName: string;

  private readonly client: Groq;

  constructor(modelName: string, apiKey?: string, client?: Groq) {
    this.modelName = modelName;
    this.client = client ?? new Groq({ apiKey: apiKey ?? process.env.GROQ_API_KEY });
  }

  async gradeQuestion(input: GradeQuestionInput, context: ModelAttemptContext): Promise<ModelResponse> {
    const messages: GroqMessage[] = [{ role: 'user', content: buildQuestionPrompt(input) }];

    if (context.repair) {
      messages.push({
        role: 'user',
        content: buildRepairPrompt(context.repair.rawResponse, context.repair.validationErrors),
      });
    }

    return this.call(SYSTEM_PROMPT, messages, 'question_grading', QUESTION_GRADING_JSON_SCHEMA, 'mark this answer');
  }

  /** Reads a rubric out of a marking scheme the structural parser could not handle. */
  async extractRubric(input: RubricExtractionInput): Promise<ModelResponse> {
    return this.call(
      RUBRIC_SYSTEM_PROMPT,
      [{ role: 'user', content: buildRubricPrompt(input) }],
      'rubric_extraction',
      RUBRIC_JSON_SCHEMA,
      'read this marking scheme',
    );
  }

  /** Derives criteria for a question whose scheme defined none. */
  async inferCriteria(input: CriteriaInferenceInput): Promise<ModelResponse> {
    return this.call(
      input.systemPrompt,
      [{ role: 'user', content: input.prompt }],
      'inferred_criteria',
      input.schema,
      'write criteria for this question',
    );
  }

  private async call(
    systemPrompt: string,
    messages: GroqMessage[],
    schemaName: string,
    schema: Record<string, unknown>,
    what: string,
  ): Promise<ModelResponse> {
    const response = await this.client.chat.completions.create({
      model: this.modelName,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      temperature: TEMPERATURE,
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName, schema, strict: true },
      },
    });

    const choice = response.choices[0];
    const raw = (choice?.message?.content ?? '').trim();

    /*
     * A refusal is not a transient failure and must never be retried as one. It
     * is surfaced as a hard error so it reaches the review flag honestly rather
     * than being retried into an outage that misreports the cause.
     */
    // Read off the type: the SDK does not declare `refusal`, but the API is
    // OpenAI-shaped and may return one, and a refusal must not be mistaken for
    // an outage.
    const refusal = (choice?.message as { refusal?: unknown } | undefined)?.refusal;
    if (typeof refusal === 'string' && refusal.trim().length > 0) {
      throw new AppError('model_output_invalid', `Groq declined to ${what}.`, {
        status: 502,
        retryable: false,
        details: [refusal.trim()],
      });
    }

    if (choice?.finish_reason === 'length') {
      // Truncated JSON fails validation anyway; say why, so the repair prompt
      // and the audit trail both show the real cause.
      return { data: null, raw: `${raw}\n\n[response truncated: hit the output limit]` };
    }

    return { data: safeJsonParse(raw), raw };
  }
}

type GroqMessage = { role: 'user' | 'assistant'; content: string };
