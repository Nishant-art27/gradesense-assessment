import type { ApiErrorCode } from '@gradesense/shared';

/**
 * Errors that carry the HTTP shape they should produce.
 *
 * Every failure the client can act on differently gets its own code, so the UI
 * can distinguish "your PDF is unreadable" from "the model is down, try again"
 * without parsing message strings.
 */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: string[];

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean; details?: string[]; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = options.status ?? 400;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? [];
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details: string[] = []) {
    super('validation_failed', message, { status: 400, details });
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super('not_found', message, { status: 404 });
  }
}

export class UnsupportedFileError extends AppError {
  constructor(message: string) {
    super('unsupported_file', message, { status: 415 });
  }
}

export class PdfUnreadableError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('pdf_unreadable', message, { status: 422, cause });
  }
}

/**
 * The model could not be reached, or kept failing, after every retry was spent.
 * Deliberately retryable and deliberately a 503: the request was valid, the
 * dependency was not available, and nothing partial has been persisted.
 */
export class ModelUnavailableError extends AppError {
  readonly attempts: number;

  constructor(message: string, attempts: number, cause?: unknown) {
    super('model_unavailable', message, { status: 503, retryable: true, cause });
    this.attempts = attempts;
  }
}

/** The model responded, but never in a shape we could use — even after repair. */
export class ModelOutputInvalidError extends AppError {
  constructor(message: string, details: string[] = []) {
    super('model_output_invalid', message, { status: 502, retryable: true, details });
  }
}

export class RubricInvalidError extends AppError {
  constructor(message: string, details: string[] = []) {
    super('rubric_invalid', message, { status: 500, details });
  }
}

export function toApiError(error: unknown): {
  status: number;
  body: { error: { code: ApiErrorCode; message: string; retryable: boolean; details: string[] } };
} {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          details: error.details,
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: 'internal_error',
        message: error instanceof Error ? error.message : 'Unexpected server error.',
        retryable: false,
        details: [],
      },
    },
  };
}
