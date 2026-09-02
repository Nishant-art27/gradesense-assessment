import Groq from 'groq-sdk';
import { describe, expect, it } from 'vitest';
import { isTransientModelError } from './providers/transient.js';
import { AppError } from '../errors.js';

/**
 * The retry policy belongs to the pipeline, not to a vendor, so it has to reach
 * the same verdict whichever SDK raised the error. Getting this wrong is
 * expensive in both directions: retrying a bad key burns quota to no purpose,
 * and giving up on a 429 loses a paper that would have graded fine.
 */
describe('deciding whether a provider failure is worth retrying', () => {
  it.each([429, 500, 502, 503, 504, 408])('retries HTTP %i', (status) => {
    expect(isTransientModelError(Object.assign(new Error('upstream'), { status }))).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])('does not retry HTTP %i', (status) => {
    expect(isTransientModelError(Object.assign(new Error('bad request'), { status }))).toBe(false);
  });

  it('reads a status nested on a response, as some transports report it', () => {
    expect(isTransientModelError({ response: { status: 503 } })).toBe(true);
    expect(isTransientModelError({ response: { status: 401 } })).toBe(false);
  });

  it('retries quota and availability messages that carry no status', () => {
    expect(isTransientModelError(new Error('Resource has been exhausted (e.g. check quota).'))).toBe(true);
    expect(isTransientModelError(new Error('The model is overloaded. Please try again.'))).toBe(true);
    expect(isTransientModelError(new Error('socket hang up'))).toBe(true);
  });

  it('honours the decision already recorded on our own errors', () => {
    const refusal = new AppError('model_output_invalid', 'declined', { retryable: false });
    const outage = new AppError('model_unavailable', 'down', { retryable: true });

    expect(isTransientModelError(refusal)).toBe(false);
    expect(isTransientModelError(outage)).toBe(true);
  });

  /*
   * Each SDK signals failure with its own error classes, so a vendor added later
   * silently falls through to the generic checks unless it is wired in. These
   * pin Groq's, the way the Anthropic ones are pinned by the fault injectors.
   */
  it('retries a Groq rate limit, which is exactly what its free tier produces', () => {
    const headers = new Headers();
    expect(
      isTransientModelError(new Groq.RateLimitError(429, { type: 'error' }, 'rate limited', headers)),
    ).toBe(true);
    expect(
      isTransientModelError(new Groq.InternalServerError(503, { type: 'error' }, 'down', headers)),
    ).toBe(true);
    expect(isTransientModelError(new Groq.APIConnectionError({ message: 'socket hang up' }))).toBe(true);
  });

  it('does not retry a Groq authentication failure', () => {
    const rejected = new Groq.AuthenticationError(401, { type: 'error' }, 'bad key', new Headers());

    expect(isTransientModelError(rejected)).toBe(false);
  });

  it('does not retry a non-error value', () => {
    expect(isTransientModelError('nope')).toBe(false);
    expect(isTransientModelError(null)).toBe(false);
  });
});
