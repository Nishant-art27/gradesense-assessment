import { config } from '../config.js';
import type { GradingModel } from './model.js';
import { AnthropicGradingModel } from './providers/anthropic.js';
import { GeminiGradingModel } from './providers/gemini.js';
import { GroqGradingModel } from './providers/groq.js';
import { MockGradingModel } from './providers/mock.js';

/**
 * Chooses the grading provider from configuration.
 *
 * `mock` is the default and always works with no credentials, so the app and its
 * whole test suite run out of the box. `config.ts` downgrades a real provider to
 * `mock` — loudly — when its key is missing, rather than starting a server that
 * fails on first use.
 *
 * Every provider goes through the same pipeline: same prompts, same schemas,
 * same clamping and evidence checks. Switching vendors changes who answers, not
 * what counts as a valid mark.
 */
export function createGradingModel(): GradingModel {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicGradingModel(config.model);
    case 'gemini':
      return new GeminiGradingModel(config.model);
    case 'groq':
      return new GroqGradingModel(config.model);
    default:
      return new MockGradingModel();
  }
}
