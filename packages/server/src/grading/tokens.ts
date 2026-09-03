import { config } from '../config.js';

/**
 * Token arithmetic for keeping every model request inside the provider's limit.
 *
 * There is no tokenizer here on purpose. Each provider tokenizes differently and
 * shipping three tokenizers to save a few percent of headroom is a poor trade.
 * The estimate is deliberately pessimistic — it over-counts prose by roughly a
 * fifth — and the safety margin in `config.tokens` absorbs the rest. Erring
 * high costs a slightly smaller chunk; erring low costs a rejected request.
 */

/**
 * English prose runs about four characters a token; maths and notation run
 * denser. Measured against Groq's own count on a CBSE marking scheme, 3.5 was
 * ten percent light, so this errs further on the side of over-counting.
 */
const CHARS_PER_TOKEN = 3.2;
/** Framing each chat message costs a few tokens beyond its text. */
const PER_MESSAGE_OVERHEAD = 4;
/** The JSON schema for structured output rides along with the request. */
const SCHEMA_OVERHEAD = 350;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  const byChars = Math.ceil(text.length / CHARS_PER_TOKEN);

  // Symbol-heavy text (equations, tables of marks) tokenizes almost glyph by
  // glyph, which the character count alone under-estimates.
  const words = (text.match(/\S+/g) ?? []).length;
  const symbols = (text.match(/[^\p{L}\p{N}\s]/gu) ?? []).length;
  const byWords = Math.ceil(words * 1.3 + symbols * 0.5);

  return Math.max(byChars, byWords);
}

/** Tokens for a whole request body: every text part plus per-message framing. */
export function estimateRequestTokens(parts: string[]): number {
  return parts.reduce((total, part) => total + estimateTokens(part) + PER_MESSAGE_OVERHEAD, SCHEMA_OVERHEAD);
}

export interface TokenBudget {
  requestLimit: number;
  completionReserve: number;
  safetyMargin: number;
}

export interface RequestPlan {
  promptTokens: number;
  completionReserve: number;
  /** What the provider admits against: prompt plus reserved completion. */
  requested: number;
  /** The ceiling after the safety margin is taken off. */
  ceiling: number;
  fits: boolean;
  /** Prompt tokens that could still be added before the request stops fitting. */
  headroom: number;
}

export function currentBudget(): TokenBudget {
  return {
    requestLimit: config.tokens.requestLimit,
    completionReserve: config.tokens.completionReserve,
    safetyMargin: config.tokens.safetyMargin,
  };
}

/**
 * What one page image costs a vision model, roughly. Measured at about 1,800
 * tokens for a 1,600-pixel page on Groq's Qwen; rounded up.
 */
export const IMAGE_PROMPT_TOKENS = 2_100;

/**
 * Sizes a request before it is sent, so an oversized one is split rather than
 * refused. `extraPromptTokens` covers content the estimator cannot see, such
 * as an attached image.
 */
export function planRequest(
  parts: string[],
  budget: TokenBudget = currentBudget(),
  extraPromptTokens = 0,
): RequestPlan {
  const promptTokens = estimateRequestTokens(parts) + extraPromptTokens;
  const ceiling = Math.floor(budget.requestLimit * (1 - budget.safetyMargin));
  const requested = promptTokens + budget.completionReserve;

  return {
    promptTokens,
    completionReserve: budget.completionReserve,
    requested,
    ceiling,
    fits: requested <= ceiling,
    headroom: ceiling - requested,
  };
}

/** The most prompt tokens any single request may carry under the current budget. */
export function maxPromptTokens(budget: TokenBudget = currentBudget()): number {
  return Math.floor(budget.requestLimit * (1 - budget.safetyMargin)) - budget.completionReserve;
}

/**
 * Output tokens to reserve when the model is asked to transcribe a chunk.
 *
 * A transcription reply is about as long as the text it copies — the scheme's
 * value points and worked answer come back nearly verbatim as JSON — and a
 * reasoning model spends tokens thinking before it writes. A flat reserve sized
 * for a grading reply cut a scheme chunk off mid-answer; this grows with the
 * chunk instead.
 */
export function transcriptionReserve(chunkTokens: number): number {
  return Math.ceil(chunkTokens * 1.4 + 900);
}

/**
 * How much of a request is left for the part that varies — a document chunk or
 * a student's answer — once the fixed parts are accounted for.
 */
export function variableAllowance(fixedParts: string[], budget: TokenBudget = currentBudget()): number {
  return Math.max(0, maxPromptTokens(budget) - estimateRequestTokens(fixedParts));
}

/**
 * Output tokens to reserve for reading a marking-scheme chunk.
 *
 * Smaller than a full transcription: the model returns the value points and
 * the examiner's notes, while the worked answer is taken from the document
 * itself (`ingest/chunk.ts#questionTexts`) rather than typed back.
 */
export function schemeReserve(chunkTokens: number): number {
  return Math.ceil(chunkTokens * 0.8 + 700);
}
