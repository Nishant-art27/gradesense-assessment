import { z } from 'zod';
import { RectSchema } from './result.js';
import { FINDING_KINDS } from './model-output.js';

/** POST /api/grade */
export const GradeRequestSchema = z.object({
  studentAnswerDocumentId: z.string().min(1),
  questionPaperDocumentId: z.string().nullish(),
  modelAnswerDocumentId: z.string().nullish(),
  /**
   * Which exam to mark against. Omitted, the server falls back to the built-in
   * rubric for the provided paper, which is what the sample flow relies on.
   */
  rubricId: z.string().nullish(),
});
export type GradeRequest = z.infer<typeof GradeRequestSchema>;

/** POST /api/results/:id/annotations — a teacher adding their own mark-up. */
export const CreateAnnotationSchema = z.object({
  questionId: z.string().nullish(),
  criterionId: z.string().nullish(),
  kind: z.enum(FINDING_KINDS).default('incorrect'),
  severity: z.enum(['minor', 'major']).default('major'),
  rect: RectSchema,
  comment: z.string().default(''),
  correction: z.string().nullish(),
});
export type CreateAnnotationRequest = z.infer<typeof CreateAnnotationSchema>;

/**
 * PATCH /api/results/:id/annotations/:annotationId
 *
 * Every field is optional: a drag sends only `rect`, a retyped correction sends
 * only `correction`. Nothing here can change a mark — editing annotations and
 * changing scores are deliberately separate operations.
 */
export const UpdateAnnotationSchema = z
  .object({
    rect: RectSchema.optional(),
    comment: z.string().optional(),
    correction: z.string().nullish(),
    kind: z.enum(FINDING_KINDS).optional(),
    severity: z.enum(['minor', 'major']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });
export type UpdateAnnotationRequest = z.infer<typeof UpdateAnnotationSchema>;

/** Uniform error envelope. `code` is stable and safe to branch on in the UI. */
export const API_ERROR_CODES = [
  'validation_failed',
  'not_found',
  'unsupported_file',
  'pdf_unreadable',
  'model_unavailable',
  'model_auth_failed',
  'model_output_invalid',
  'provider_unsupported',
  'rubric_invalid',
  /** One request would exceed the provider's token ceiling even after splitting. */
  'request_too_large',
  'internal_error',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    /** Set when the failure is transient and retrying may succeed. */
    retryable: z.boolean(),
    details: z.array(z.string()),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
