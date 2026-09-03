import { GoogleGenAI } from '@google/genai';
import {
  ANSWER_CHUNK_SYSTEM_PROMPT,
  QUESTION_PAPER_CHUNK_SYSTEM_PROMPT,
  RUBRIC_SYSTEM_PROMPT,
  SCHEME_CHUNK_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  TRANSCRIPTION_SYSTEM_PROMPT,
  buildAnswerChunkPrompt,
  buildQuestionPaperChunkPrompt,
  buildQuestionPrompt,
  buildRepairPrompt,
  buildRubricPrompt,
  buildSchemeChunkPrompt,
  buildTranscriptionPrompt,
  type AnswerChunkInput,
  type DocumentChunkInput,
  type GradeQuestionInput,
  type GradingModel,
  type ModelAttemptContext,
  type CriteriaInferenceInput,
  type ModelResponse,
  type PageTranscriptionInput,
  type RubricExtractionInput,
} from '../model.js';
import {
  ANSWER_CHUNK_JSON_SCHEMA,
  PAGE_TRANSCRIPT_JSON_SCHEMA,
  QUESTION_GRADING_JSON_SCHEMA,
  QUESTION_PAPER_CHUNK_JSON_SCHEMA,
  RUBRIC_JSON_SCHEMA,
  SCHEME_CHUNK_JSON_SCHEMA,
} from '../output-schema.js';
import { AppError } from '../../errors.js';
import { safeJsonParse } from './json.js';

/**
 * Grading through Google's Gemini models.
 *
 * The prompts, the JSON schemas and every validation rule are shared with the
 * Anthropic provider — only the transport differs. That is the point of the
 * `GradingModel` seam: swapping vendors must not change what counts as a valid
 * mark, or the reliability guarantees would be per-provider rather than
 * properties of the system.
 *
 * As with Anthropic, the student's whole answer sheet goes along as an inline
 * PDF, so the model can see the circuit diagram and the demand/supply graph
 * rather than only the extracted text. The diagram criteria are ungradeable
 * otherwise.
 */
export class GeminiGradingModel implements GradingModel {
  readonly providerName = 'gemini';
  readonly modelName: string;

  private readonly client: GoogleGenAI;

  constructor(modelName: string, apiKey?: string, client?: GoogleGenAI) {
    this.modelName = modelName;
    this.client = client ?? new GoogleGenAI({ apiKey: apiKey ?? process.env.GEMINI_API_KEY });
  }

  async gradeQuestion(input: GradeQuestionInput, context: ModelAttemptContext): Promise<ModelResponse> {
    const parts: Array<Record<string, unknown>> = [];

    if (input.pdfBase64) {
      parts.push({ inlineData: { mimeType: 'application/pdf', data: input.pdfBase64 } });
    }
    parts.push({ text: buildQuestionPrompt(input) });

    if (context.repair) {
      parts.push({ text: buildRepairPrompt(context.repair.rawResponse, context.repair.validationErrors) });
    }

    return this.call(SYSTEM_PROMPT, parts, QUESTION_GRADING_JSON_SCHEMA, 'mark this answer');
  }

  /**
   * Reads a rubric out of a marking scheme the structural parser could not
   * handle. Text-only: a scheme's content is its words, so sending the PDF too
   * would cost tokens for no extra signal.
   */
  async extractRubric(input: RubricExtractionInput): Promise<ModelResponse> {
    return this.call(
      RUBRIC_SYSTEM_PROMPT,
      [{ text: buildRubricPrompt(input) }],
      RUBRIC_JSON_SCHEMA,
      'read this marking scheme',
    );
  }

  /** Reads the questions in one excerpt of a question paper. */
  async extractQuestionPaperChunk(input: DocumentChunkInput): Promise<ModelResponse> {
    return this.call(
      QUESTION_PAPER_CHUNK_SYSTEM_PROMPT,
      [{ text: buildQuestionPaperChunkPrompt(input) }],
      QUESTION_PAPER_CHUNK_JSON_SCHEMA,
      'read this part of the question paper',
    );
  }

  /** Reads the marking in one excerpt of a marking scheme. */
  async extractSchemeChunk(input: DocumentChunkInput): Promise<ModelResponse> {
    return this.call(
      SCHEME_CHUNK_SYSTEM_PROMPT,
      [{ text: buildSchemeChunkPrompt(input) }],
      SCHEME_CHUNK_JSON_SCHEMA,
      'read this part of the marking scheme',
    );
  }

  /** Says which questions one excerpt of an answer sheet is answering. */
  async attributeAnswerChunk(input: AnswerChunkInput): Promise<ModelResponse> {
    return this.call(
      ANSWER_CHUNK_SYSTEM_PROMPT,
      [{ text: buildAnswerChunkPrompt(input) }],
      ANSWER_CHUNK_JSON_SCHEMA,
      'read this part of the answer sheet',
    );
  }

  /** Derives criteria for a question whose scheme defined none. */
  async inferCriteria(input: CriteriaInferenceInput): Promise<ModelResponse> {
    return this.call(input.systemPrompt, [{ text: input.prompt }], input.schema, 'write criteria for this question');
  }

  /** Reads one scanned page of handwriting. Gemini sees images natively, so the grading model does this too. */
  async transcribePage(input: PageTranscriptionInput): Promise<ModelResponse> {
    return this.call(
      TRANSCRIPTION_SYSTEM_PROMPT,
      [
        { inlineData: { mimeType: input.mimeType, data: input.imageBase64 } },
        { text: buildTranscriptionPrompt(input) },
      ],
      PAGE_TRANSCRIPT_JSON_SCHEMA,
      'transcribe this page of handwriting',
    );
  }

  private async call(
    systemInstruction: string,
    parts: Array<Record<string, unknown>>,
    schema: Record<string, unknown>,
    what: string,
  ): Promise<ModelResponse> {
    const response = await this.client.models.generateContent({
      model: this.modelName,
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseJsonSchema: toGeminiSchema(schema),
        // Marking is a reasoning task, not a creative one: the same answer should
        // get the same marks twice in a row.
        temperature: 0,
      },
    });

    const candidate = response.candidates?.[0];
    const finish = candidate?.finishReason;

    /*
     * A safety block is not a transient failure and must never be retried as
     * one. It is surfaced as a hard error so it reaches the review flag honestly
     * rather than being silently retried into a timeout.
     */
    if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'BLOCKLIST') {
      throw new AppError('model_output_invalid', `Gemini declined to ${what}.`, {
        status: 502,
        retryable: false,
        details: [`Finish reason: ${finish}.`],
      });
    }

    const raw = (response.text ?? '').trim();

    if (finish === 'MAX_TOKENS') {
      // Truncated JSON will fail validation anyway; say why, so the repair
      // prompt and the audit trail both show the real cause.
      return { data: null, raw: `${raw}\n\n[response truncated: hit the output limit]` };
    }

    return { data: safeJsonParse(raw), raw };
  }
}

/**
 * Adapts our JSON Schema to what Gemini's structured output accepts.
 *
 * Two differences matter. Gemini expresses "or null" as `nullable: true` rather
 * than a `["string", "null"]` type union, and it rejects `additionalProperties`.
 * Converting here rather than keeping a second copy of every schema means the
 * Anthropic and Gemini providers stay provably in step — `schema-parity.test.ts`
 * only has one contract to check.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (typeof schema !== 'object' || schema === null) return schema;

  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    // Gemini enforces the schema itself; the keyword is rejected as unknown.
    if (key === 'additionalProperties') continue;

    if (key === 'type' && Array.isArray(value)) {
      const types = value.filter((entry) => entry !== 'null');
      out.type = types.length === 1 ? types[0] : types;
      if (value.includes('null')) out.nullable = true;
      continue;
    }

    out[key] = toGeminiSchema(value);
  }

  return out;
}
