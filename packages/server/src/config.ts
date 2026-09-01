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

export type ProviderName = 'mock' | 'anthropic';

/**
 * `mock` is the default on purpose. A reviewer with no API key must be able to
 * clone, install, run the app and run the whole test suite without editing
 * anything — so the deterministic provider is what you get unless you ask for
 * the real one.
 */
function resolveProvider(): ProviderName {
  const requested = (process.env.MODEL_PROVIDER ?? 'mock').toLowerCase();
  if (requested === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn(
        '[config] MODEL_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set. Falling back to the mock provider.',
      );
      return 'mock';
    }
    return 'anthropic';
  }
  return 'mock';
}

export const config = {
  port: num(process.env.PORT, 4000),
  provider: resolveProvider(),
  model: process.env.GRADING_MODEL ?? 'claude-opus-5',

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
} as const;

export type Config = typeof config;
