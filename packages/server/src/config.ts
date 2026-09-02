import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

dotenv.config({ path: path.join(REPO_ROOT, '.env') });

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type ProviderName = 'mock' | 'anthropic' | 'gemini' | 'groq';

const KEY_FOR: Record<Exclude<ProviderName, 'mock'>, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
};

const LIVE_PROVIDERS = Object.keys(KEY_FOR) as Array<Exclude<ProviderName, 'mock'>>;

function isLiveProvider(name: string): name is Exclude<ProviderName, 'mock'> {
  return (LIVE_PROVIDERS as string[]).includes(name);
}

/**
 * `mock` is the default on purpose. A reviewer with no API key must be able to
 * clone, install, run the app and run the whole test suite without editing
 * anything — so the deterministic provider is what you get unless a real one is
 * asked for by name *and* its key is present.
 */
function resolveProvider(): ProviderName {
  const requested = (process.env.MODEL_PROVIDER ?? 'mock').toLowerCase();
  if (requested === 'mock') return 'mock';

  if (!isLiveProvider(requested)) {
    console.warn(
      `[config] MODEL_PROVIDER="${requested}" is not recognised. Expected mock, ${LIVE_PROVIDERS.join(', ')}. Using the mock provider.`,
    );
    return 'mock';
  }

  // Falling back beats starting a server that fails on its first request, but it
  // must be said out loud — silently marking with the demo grader when a real one
  // was asked for would be the worst of both.
  const keyName = KEY_FOR[requested];
  if (!process.env[keyName]) {
    console.warn(
      `[config] MODEL_PROVIDER=${requested} but ${keyName} is not set. Falling back to the mock provider.`,
    );
    return 'mock';
  }

  return requested;
}

/**
 * Default model per provider, overridable with GRADING_MODEL.
 *
 * Gemini Flash is chosen over Pro because marking is a bounded, schema-guided
 * task rather than open-ended generation, and a paper costs one call per
 * question — latency and price compound across a class.
 */
const DEFAULT_MODEL: Record<ProviderName, string> = {
  mock: 'rule-based-mock',
  anthropic: 'claude-opus-5',
  gemini: 'gemini-2.5-flash',
  // Groq's strict structured-output support is limited to a few models, and this
  // is the most capable of them. Picking one without it would fail every call.
  groq: 'openai/gpt-oss-120b',
};

const PROVIDER = resolveProvider();

export const config = {
  port: num(process.env.PORT, 4000),
  provider: PROVIDER,
  model: process.env.GRADING_MODEL ?? DEFAULT_MODEL[PROVIDER],

  paths: {
    repoRoot: REPO_ROOT,
    /** Uploaded PDF bytes and grading history. Safe to delete; regenerated on use. */
    data: path.join(REPO_ROOT, 'data'),
    uploads: path.join(REPO_ROOT, 'data', 'uploads'),
    rubric: path.join(REPO_ROOT, 'fixtures', 'rubric.json'),
    answers: path.join(REPO_ROOT, 'fixtures', 'answers'),
    exports: path.join(REPO_ROOT, 'exports'),
  },

  grading: {
    /** Below this, the result is flagged for a human. */
    confidenceReviewThreshold: num(process.env.CONFIDENCE_REVIEW_THRESHOLD, 0.65),
    /**
     * A question whose extracted answer text is shorter than this — and which has
     * no diagram ink to fall back on — is treated as unanswered without spending
     * a model call on it.
     */
    blankAnswerMinChars: 25,
    /** Marks are snapped to this granularity after clamping. */
    markGranularity: 0.5,
    /** Attempts per question before the model is declared unavailable. */
    maxModelAttempts: 3,
    /** One extra attempt is spent re-asking for valid JSON when parsing fails. */
    maxRepairAttempts: 1,
    /** Base delay for exponential backoff between transient failures, in ms. */
    retryBaseDelayMs: 400,
  },

  uploads: {
    maxBytes: 25 * 1024 * 1024,
  },

  /**
   * Token budgeting for the model provider.
   *
   * Groq admits a request only if `prompt tokens + max_completion_tokens` fits
   * inside the tokens-per-minute allowance — 8,000 for openai/gpt-oss-120b on
   * the free tier. So every request is sized against two ceilings at once: the
   * single-request limit, and the rolling minute shared with the requests
   * before it. The defaults for the other providers are large enough never to
   * bite on real input, so they only pay for the accounting.
   */
  tokens: {
    /** Per-request ceiling the provider enforces on prompt + reserved completion. */
    requestLimit: num(process.env.MODEL_REQUEST_TOKEN_LIMIT, PROVIDER === 'groq' ? 8_000 : 150_000),
    /** Rolling-minute allowance across all requests. */
    tokensPerMinute: num(process.env.MODEL_TOKENS_PER_MINUTE, PROVIDER === 'groq' ? 8_000 : 1_000_000),
    /**
     * Output tokens reserved on every request. Counted by the provider as if
     * spent, so it is kept to what a full structured answer actually needs
     * rather than a generous round number.
     */
    completionReserve: num(process.env.MODEL_COMPLETION_RESERVE, PROVIDER === 'groq' ? 3_000 : 16_000),
    /** Document text per chunk when a paper is read in pieces. */
    chunkTokens: num(process.env.MODEL_CHUNK_TOKENS, PROVIDER === 'groq' ? 2_500 : 12_000),
    /** Fraction of the request limit deliberately left unused, because the estimate is an estimate. */
    safetyMargin: 0.08,
  },
} as const;

export type Config = typeof config;
