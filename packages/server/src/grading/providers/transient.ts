import Anthropic from '@anthropic-ai/sdk';
import Groq from 'groq-sdk';
import { AppError, ModelAuthError, ModelUnavailableError } from '../../errors.js';

/**
 * Whether a provider failure is worth retrying.
 *
 * Rate limits, connection drops and 5xx responses are transient — the same
 * request may well succeed a moment later. A bad request, a bad key or a
 * refusal will fail identically forever, so retrying only delays an honest
 * error and burns quota.
 *
 * This lives apart from any one provider because the retry policy belongs to the
 * pipeline, not to a vendor. Each SDK signals failure differently, so the checks
 * are per-SDK but the decision is shared.
 */

const TRANSIENT_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  // The Google SDK surfaces `status`; some transports use `code` or nest it.
  const candidate = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const value of [candidate.status, candidate.code, candidate.response?.status]) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  }
  return null;
}

/** A refusal because the minute's allowance is spent, as distinct from an outage. */
export function isRateLimitError(error: unknown): boolean {
  if (error instanceof Anthropic.RateLimitError || error instanceof Groq.RateLimitError) return true;
  if (statusOf(error) === 429) return true;
  return error instanceof Error && /rate limit|too many requests|quota/i.test(error.message);
}

export function isTransientModelError(error: unknown): boolean {
  // Errors we raised ourselves already carry an explicit decision.
  if (error instanceof AppError) return error.retryable;

  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.InternalServerError) return true;
  if (error instanceof Anthropic.APIError) {
    return typeof error.status === 'number' && TRANSIENT_STATUSES.has(error.status);
  }

  if (error instanceof Groq.RateLimitError) return true;
  if (error instanceof Groq.APIConnectionError) return true;
  if (error instanceof Groq.InternalServerError) return true;
  if (error instanceof Groq.APIError) {
    return typeof error.status === 'number' && TRANSIENT_STATUSES.has(error.status);
  }

  const status = statusOf(error);
  if (status !== null) return TRANSIENT_STATUSES.has(status);

  // Google's SDK reports quota and availability problems as messages when no
  // numeric status survives the transport.
  if (error instanceof Error && /rate limit|quota|exhausted|unavailable|overloaded|timeout|socket/i.test(error.message)) {
    return true;
  }

  // Anything else that is merely an Error — a dropped socket, an aborted
  // fetch — is treated as transient. A programming mistake would not be an
  // Error subclass reaching this far.
  return error instanceof Error;
}

/* -------------------------- turning failures into UI ------------------------- */

const AUTH_STATUSES = new Set([401, 403]);
/** Long enough to diagnose, short enough not to be a wall of JSON. */
const SUMMARY_MAX = 200;

/**
 * The provider's own account of what went wrong, in one line.
 *
 * SDK errors carry the raw HTTP body as their message — a whole JSON document
 * including `@type` URLs and a `details` array. Shown to a teacher that is
 * noise; kept entirely out of the response it is undiagnosable. So the nested
 * `error.message` is unwrapped and truncated, and the untouched original stays
 * on the error's `cause` for the server log.
 */
function summarise(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  if (!message) return null;

  let text = message;
  const start = message.indexOf('{');
  if (start >= 0) {
    try {
      const body = JSON.parse(message.slice(start)) as { error?: { message?: unknown } };
      if (typeof body.error?.message === 'string') text = body.error.message;
    } catch {
      // Not JSON after all; the message stands as written.
    }
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

/**
 * Converts a provider failure that retrying cannot fix into an error a person
 * can act on.
 *
 * Without this the raw SDK error escapes to the API's last-resort handler, which
 * puts `error.message` straight in the response — so a rejected key reached the
 * browser as a wall of Google's JSON, telling a teacher marking a paper about
 * OAuth 2 access tokens. The failure is real either way; what changes is whether
 * the person reading it can tell what to do.
 *
 * Errors we raised ourselves already carry a considered message and pass
 * through untouched.
 */
export function asModelFailure(error: unknown, providerName: string): AppError {
  if (error instanceof AppError) return error;

  const status = statusOf(error);
  const summary = summarise(error);
  const detail = summary ? [`${providerName} said: ${summary}`] : [];

  if (isRateLimitError(error)) {
    return new ModelUnavailableError(
      `${providerName}'s token allowance is exhausted, so nothing was marked. Wait a minute and try again${
        summary && /per day/i.test(summary) ? ', or, since this is the daily limit, upgrade the tier or wait for it to reset' : ''
      }.`,
      1,
      error,
    );
  }

  if (status !== null && AUTH_STATUSES.has(status)) {
    return new ModelAuthError(
      `${providerName} rejected the API key, so nothing was marked. Check the key in your .env file — it may be missing, mistyped, or expired — then restart the server.`,
      detail,
    );
  }

  return new AppError(
    'internal_error',
    `${providerName} refused the request, so nothing was marked. This is not a temporary outage, so retrying will not help.`,
    { status: 502, retryable: false, details: detail, cause: error },
  );
}
