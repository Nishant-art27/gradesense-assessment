import type {
  Annotation,
  ApiError,
  CreateAnnotationRequest,
  DocumentKind,
  DocumentSummary,
  GradingResult,
  GradingSummary,
  Rubric,
  UpdateAnnotationRequest,
} from '@gradesense/shared';

export interface RubricDraft {
  rubric: Rubric;
  /** 'parsed' when read structurally, 'model' when the language model read it. */
  source: 'parsed' | 'model';
  warnings: string[];
}

/**
 * Typed API client.
 *
 * Request and response shapes come from the shared package, so the compiler
 * catches a mismatch between the two halves of the app rather than the browser
 * discovering it at runtime.
 */

export class ApiRequestError extends Error {
  readonly code: ApiError['error']['code'];
  readonly retryable: boolean;
  readonly details: string[];
  readonly status: number;

  constructor(status: number, body: ApiError) {
    super(body.error.message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body.error.code;
    this.retryable = body.error.retryable;
    this.details = body.error.details;
  }
}

async function unwrap<T>(response: Response): Promise<T> {
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  let body: ApiError;
  try {
    body = (await response.json()) as ApiError;
  } catch {
    throw new ApiRequestError(response.status, {
      error: {
        code: 'internal_error',
        message: `Request failed with status ${response.status}.`,
        retryable: response.status >= 500,
        details: [],
      },
    });
  }
  throw new ApiRequestError(response.status, body);
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  return unwrap<T>(response);
}

export interface HealthInfo {
  status: string;
  provider: string;
  model: string;
  live: boolean;
}

export interface GradedPaper {
  result: GradingResult;
  annotations: Annotation[];
}

export const api = {
  health: () => json<HealthInfo>('/api/health'),

  rubric: () => json<Rubric>('/api/rubric'),

  /** Uploads raw PDF bytes. No multipart: the server takes the file body directly. */
  uploadDocument: async (file: File, kind: DocumentKind): Promise<DocumentSummary> => {
    const params = new URLSearchParams({ kind, filename: file.name });
    const response = await fetch(`/api/documents?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: file,
    });
    return unwrap<DocumentSummary>(response);
  },

  listSampleAnswers: () => json<{ answers: string[] }>('/api/samples'),

  /** Loads the authored sample set: question paper, model answer and one student answer. */
  loadSample: (answer: string) =>
    json<{
      studentAnswer: DocumentSummary;
      questionPaper: DocumentSummary | null;
      modelAnswer: DocumentSummary | null;
    }>('/api/samples', { method: 'POST', body: JSON.stringify({ answer }) }),

  /** Reads a draft rubric out of an uploaded marking scheme. Nothing is saved yet. */
  extractRubric: (modelAnswerDocumentId: string, questionPaperDocumentId?: string | null) =>
    json<RubricDraft>('/api/rubrics/extract', {
      method: 'POST',
      body: JSON.stringify({ modelAnswerDocumentId, questionPaperDocumentId }),
    }),

  /** Saves a rubric a human has reviewed. Only a saved rubric can mark a paper. */
  saveRubric: (rubric: Rubric) =>
    json<Rubric>('/api/rubrics', { method: 'POST', body: JSON.stringify({ rubric }) }),

  listRubrics: () => json<Rubric[]>('/api/rubrics'),

  grade: (
    studentAnswerDocumentId: string,
    extra?: {
      rubricId?: string | null;
      questionPaperDocumentId?: string | null;
      modelAnswerDocumentId?: string | null;
    },
  ) =>
    json<GradedPaper>('/api/grade', {
      method: 'POST',
      body: JSON.stringify({ studentAnswerDocumentId, ...extra }),
    }),

  listResults: () => json<GradingSummary[]>('/api/results'),

  getResult: (id: string) => json<GradedPaper>(`/api/results/${id}`),

  /*
   * The three annotation calls below never touch a mark. That is the whole point
   * of the "editable output" requirement: a teacher rearranges the mark-up and
   * the grading stands.
   */
  createAnnotation: (resultId: string, body: CreateAnnotationRequest) =>
    json<Annotation>(`/api/results/${resultId}/annotations`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateAnnotation: (resultId: string, annotationId: string, body: UpdateAnnotationRequest) =>
    json<Annotation>(`/api/results/${resultId}/annotations/${annotationId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deleteAnnotation: (resultId: string, annotationId: string) =>
    json<void>(`/api/results/${resultId}/annotations/${annotationId}`, { method: 'DELETE' }),

  /** Downloads the annotated copy. The original is never modified server-side. */
  exportAnnotated: async (resultId: string, filename: string): Promise<void> => {
    const response = await fetch(`/api/results/${resultId}/export`, { method: 'POST' });
    if (!response.ok) {
      await unwrap<never>(response);
      return;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },

  documentFileUrl: (documentId: string) => `/api/documents/${documentId}/file`,
};
