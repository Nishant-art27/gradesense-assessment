import { config } from '../config.js';
import type { GradingModel } from './model.js';
import { AnthropicGradingModel } from './providers/anthropic.js';
import { MockGradingModel } from './providers/mock.js';

/**
 * Chooses the grading provider from configuration.
 *
 * `mock` is the default, and `config.ts` downgrades an `anthropic` request to
 * `mock` when no credentials are present rather than starting a server that
 * fails on first use.
 */
export function createGradingModel(): GradingModel {
  if (config.provider === 'anthropic') {
    return new AnthropicGradingModel(config.model);
  }
  return new MockGradingModel();
}
