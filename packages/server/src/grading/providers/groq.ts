import Groq from 'groq-sdk';
import { config } from '../../config.js';
import { AppError, RequestTooLargeError } from '../../errors.js';
import {
  ANSWER_CHUNK_SYSTEM_PROMPT,
  QUESTION_PAPER_CHUNK_SYSTEM_PROMPT,
  RUBRIC_SYSTEM_PROMPT,
  SCHEME_CHUNK_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  buildAnswerChunkPrompt,
  buildQuestionPaperChunkPrompt,
  buildQuestionPrompt,
  buildRepairPrompt,
  buildRubricPrompt,
  buildSchemeChunkPrompt,
  type AnswerChunkInput,
  type CriteriaInferenceInput,
  type DocumentChunkInput,
  type GradeQuestionInput,
  type GradingModel,
  type ModelAttemptContext,
  type ModelResponse,
  type RubricExtractionInput,
} from '../model.js';
import {
  ANSWER_CHUNK_JSON_SCHEMA,
  QUESTION_GRADING_JSON_SCHEMA,
  QUESTION_PAPER_CHUNK_JSON_SCHEMA,
  RUBRIC_JSON_SCHEMA,
  SCHEME_CHUNK_JSON_SCHEMA,
} from '../output-schema.js';
import { TokenRateLimiter } from '../rate-limit.js';
import { currentBudget, estimateTokens, planRequest, transcriptionReserve, variableAllowance } from '../tokens.js';
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
 *  3. **Every request is sized and paced before it leaves.** Groq admits a
 *     request against `prompt tokens + max_completion_tokens`, and on the free
 *     tier the whole minute's allowance for gpt-oss-120b is 8,000 tokens. A
 *     request that reserved 16,000 tokens for its reply was therefore refused
 *     before its prompt was even looked at, however small the prompt. So the
 *     completion reservation is now what a full structured answer needs and
 *     no more; each request is estimated against the ceiling and refused
 *     locally, as a `RequestTooLargeError` the callers know to split on, rather
 *     than remotely; and all requests pass through one rate limiter that keeps
 *     the rolling minute inside the allowance and runs them one at a time.
 *
 * The API is OpenAI-shaped, so this file is also the template for any
 * OpenAI-compatible vendor.
 */

/** Marking is a reasoning task: the same answer should get the same marks twice. */
const TEMPERATURE = 0;

/** Models on Groq that accept `reasoning_effort`; others reject the parameter. */
const REASONING_MODELS = /gpt-oss|qwen/i;

type ReasoningEffort = 'low' | 'medium' | 'high';

interface CallOptions {
  /**
   * Output tokens to reserve for this call. Defaults to the grading reserve;
   * transcription calls pass one sized to the chunk they copy.
   */
  completionReserve?: number;
  reasoningEffort?: ReasoningEffort;
}

/** Attribution replies are a short list, whatever the size of the excerpt. */
const ATTRIBUTION_RESERVE = 1_500;

/**
 * One limiter for the process, not one per instance: the allowance belongs to
 * the API key, and every request made with it counts against the same minute.
 */
let sharedLimiter: TokenRateLimiter | null = null;
function defaultLimiter(): TokenRateLimiter {
  sharedLimiter ??= new TokenRateLimiter({
    tokensPerMinute: config.tokens.tokensPerMinute,
    onWait: (_ms, reason) => console.warn(`[groq] ${reason}`),
  });
  return sharedLimiter;
}

export class GroqGradingModel implements GradingModel {
  readonly providerName = 'groq';
  readonly modelName: string;

  private readonly client: Groq;
  private readonly limiter: TokenRateLimiter;

  constructor(modelName: string, apiKey?: string, client?: Groq, limiter?: TokenRateLimiter) {
    this.modelName = modelName;
    this.client = client ?? new Groq({ apiKey: apiKey ?? process.env.GROQ_API_KEY });
    this.limiter = limiter ?? defaultLimiter();
  }

  async gradeQuestion(input: GradeQuestionInput, context: ModelAttemptContext): Promise<ModelResponse> {
    const questionPrompt = buildQuestionPrompt(input);
    const messages: GroqMessage[] = [{ role: 'user', content: questionPrompt }];

    if (context.repair) {
      // The repair prompt quotes the bad response back. Quote only as much of it
      // as still fits, so the repair is not itself the request that is too large.
      const skeleton = buildRepairPrompt('', context.repair.validationErrors, 0);
      const spareTokens = variableAllowance([SYSTEM_PROMPT, questionPrompt, skeleton]);
      const excerptChars = Math.max(400, Math.floor(spareTokens * 3));
      messages.push({
        role: 'user',
        content: buildRepairPrompt(context.repair.rawResponse, context.repair.validationErrors, excerptChars),
      });
    }

    return this.call(SYSTEM_PROMPT, messages, 'question_grading', QUESTION_GRADING_JSON_SCHEMA, 'mark this answer', {
      reasoningEffort: config.tokens.reasoningEffort,
    });
  }

  /**
   * Reads a whole rubric in one request. Kept so the interface is complete, but
   * the pipeline prefers the chunk-level readers below, which are what keep a
   * real marking scheme inside the token limit.
   */
  async extractRubric(input: RubricExtractionInput): Promise<ModelResponse> {
    return this.call(
      RUBRIC_SYSTEM_PROMPT,
      [{ role: 'user', content: buildRubricPrompt(input) }],
      'rubric_extraction',
      RUBRIC_JSON_SCHEMA,
      'read this marking scheme',
    );
  }

  /**
   * Reads the questions in one excerpt of a question paper.
   *
   * Transcription, not judgement: the reply is as long as the excerpt it copies,
   * so the reserve is sized to the chunk, and the model is told not to think
   * hard about it — its thinking comes out of the same reply budget.
   */
  async extractQuestionPaperChunk(input: DocumentChunkInput): Promise<ModelResponse> {
    return this.call(
      QUESTION_PAPER_CHUNK_SYSTEM_PROMPT,
      [{ role: 'user', content: buildQuestionPaperChunkPrompt(input) }],
      'question_paper_chunk',
      QUESTION_PAPER_CHUNK_JSON_SCHEMA,
      'read this part of the question paper',
      { completionReserve: transcriptionReserve(estimateTokens(input.chunk.text)), reasoningEffort: 'low' },
    );
  }

  /** Reads the marking in one excerpt of a marking scheme. Transcription; see above. */
  async extractSchemeChunk(input: DocumentChunkInput): Promise<ModelResponse> {
    return this.call(
      SCHEME_CHUNK_SYSTEM_PROMPT,
      [{ role: 'user', content: buildSchemeChunkPrompt(input) }],
      'marking_scheme_chunk',
      SCHEME_CHUNK_JSON_SCHEMA,
      'read this part of the marking scheme',
      { completionReserve: transcriptionReserve(estimateTokens(input.chunk.text)), reasoningEffort: 'low' },
    );
  }

  /** Says which questions one excerpt of an answer sheet is answering. */
  async attributeAnswerChunk(input: AnswerChunkInput): Promise<ModelResponse> {
    return this.call(
      ANSWER_CHUNK_SYSTEM_PROMPT,
      [{ role: 'user', content: buildAnswerChunkPrompt(input) }],
      'answer_sheet_chunk',
      ANSWER_CHUNK_JSON_SCHEMA,
      'read this part of the answer sheet',
      { completionReserve: ATTRIBUTION_RESERVE, reasoningEffort: 'low' },
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
    options: CallOptions = {},
  ): Promise<ModelResponse> {
    // Size it here, before the network. A request the provider would refuse is
    // refused locally as something the caller knows how to split.
    const budget = currentBudget();
    if (options.completionReserve !== undefined) budget.completionReserve = options.completionReserve;
    const plan = planRequest([systemPrompt, ...messages.map((message) => message.content)], budget);
    if (!plan.fits) {
      throw new RequestTooLargeError(
        `A request to ${what} would be about ${plan.requested} tokens (≈${plan.promptTokens} of prompt plus ${plan.completionReserve} reserved for the reply), above the ${plan.ceiling}-token ceiling for one request. It has to be split.`,
        plan.requested,
        plan.ceiling,
      );
    }

    return this.limiter.schedule(plan.requested, async () => {
      let completion: Groq.Chat.Completions.ChatCompletion;
      let headers: Headers | null = null;
      try {
        const result = await this.client.chat.completions
          .create({
            model: this.modelName,
            messages: [{ role: 'system', content: systemPrompt }, ...messages],
            temperature: TEMPERATURE,
            max_completion_tokens: plan.completionReserve,
            ...(options.reasoningEffort && REASONING_MODELS.test(this.modelName)
              ? { reasoning_effort: options.reasoningEffort }
              : {}),
            response_format: {
              type: 'json_schema',
              json_schema: { name: schemaName, schema, strict: true },
            },
          })
          .withResponse();
        completion = result.data;
        headers = result.response.headers;
      } catch (error) {
        // The estimate under-counted and Groq refused the size. Not transient:
        // the same request would be refused again, so it is reported as the
        // splittable kind of failure rather than retried into an "outage".
        if (isTooLarge(error)) {
          throw new RequestTooLargeError(
            `Groq refused a request to ${what} as too large (estimated ${plan.requested} tokens). It has to be split further.`,
            plan.requested,
            plan.ceiling,
            [summariseError(error)],
          );
        }

        /*
         * Groq validates the reply against the schema itself and returns a 400
         * when it does not conform — which is what a reply cut off by the
         * output cap looks like. That is malformed output, not a refusal: the
         * partial text is handed back so the caller can repair or split, the
         * same as it would for any other unusable reply.
         */
        const failed = failedGeneration(error);
        if (failed !== null) {
          return [
            {
              data: safeJsonParse(failed),
              raw: `${failed}\n\n[Groq rejected this reply as not matching the schema — usually because it was cut off by the ${plan.completionReserve}-token output limit]`,
            },
            { usedTokens: null },
          ];
        }
        throw error;
      }

      const choice = completion.choices[0];
      const raw = (choice?.message?.content ?? '').trim();

      /*
       * A refusal is not a transient failure and must never be retried as one.
       * It is surfaced as a hard error so it reaches the review flag honestly
       * rather than being retried into an outage that misreports the cause.
       */
      // Read off the type: the SDK does not declare `refusal`, but the API is
      // OpenAI-shaped and may return one, and a refusal must not be mistaken
      // for an outage.
      const refusal = (choice?.message as { refusal?: unknown } | undefined)?.refusal;
      if (typeof refusal === 'string' && refusal.trim().length > 0) {
        throw new AppError('model_output_invalid', `Groq declined to ${what}.`, {
          status: 502,
          retryable: false,
          details: [refusal.trim()],
        });
      }

      const outcome = {
        usedTokens: completion.usage?.total_tokens ?? null,
        remainingTokens: headerNumber(headers, 'x-ratelimit-remaining-tokens'),
        resetInMs: headerDuration(headers, 'x-ratelimit-reset-tokens'),
      };

      if (choice?.finish_reason === 'length') {
        // Truncated JSON fails validation anyway; say why, so the repair prompt
        // and the audit trail both show the real cause.
        return [
          { data: null, raw: `${raw}\n\n[response truncated: hit the ${plan.completionReserve}-token output limit]` },
          outcome,
        ];
      }

      return [{ data: safeJsonParse(raw), raw }, outcome];
    });
  }
}

type GroqMessage = { role: 'user' | 'assistant'; content: string };

/** Groq's "Request too large … tokens per minute (TPM)" arrives as a 413. */
function isTooLarge(error: unknown): boolean {
  if (error instanceof Groq.APIError) {
    if (error.status === 413) return true;
    return /request too large|reduce your message size|tokens per minute/i.test(error.message);
  }
  return false;
}

/**
 * The partial reply Groq attaches to a `json_validate_failed` error, or null
 * when the error is something else.
 */
function failedGeneration(error: unknown): string | null {
  if (!(error instanceof Groq.APIError) || error.status !== 400) return null;
  const body = (error as { error?: { error?: Record<string, unknown> } }).error?.error ?? {};
  const isValidation =
    body.code === 'json_validate_failed' || /failed to validate json/i.test(String(body.message ?? error.message));
  if (!isValidation) return null;
  return typeof body.failed_generation === 'string' ? body.failed_generation : '';
}

function summariseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 200);
}

function headerNumber(headers: Headers | null, name: string): number | null {
  const value = headers?.get(name);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Groq writes reset times like "2m59.56s", "7.66s" or "1h2m3s". */
function headerDuration(headers: Headers | null, name: string): number | null {
  const value = headers?.get(name);
  if (!value) return null;
  const pattern = /(\d+(?:\.\d+)?)(h|m|s|ms)/g;
  let total = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2];
    total += unit === 'h' ? amount * 3_600_000 : unit === 'm' ? amount * 60_000 : unit === 's' ? amount * 1000 : amount;
  }
  return matched ? Math.ceil(total) : null;
}
