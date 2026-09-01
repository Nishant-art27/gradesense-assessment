import { z } from 'zod';
import { RectSchema } from './result.js';

export const DOCUMENT_KINDS = ['question_paper', 'model_answer', 'student_answer'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * One run of text from the PDF text layer, carrying both its position on the
 * page and its character range within `PageText.text`. That pairing is what
 * turns a quote from the model back into a rectangle on the page.
 */
export const TextRunSchema = z.object({
  text: z.string(),
  /** Inclusive start offset into the owning page's `text`. */
  start: z.number().int().nonnegative(),
  /** Exclusive end offset. */
  end: z.number().int().nonnegative(),
  rect: RectSchema,
});
export type TextRun = z.infer<typeof TextRunSchema>;

export const PageTextSchema = z.object({
  index: z.number().int().nonnegative(),
  /** Page dimensions in PDF points, kept so exports can denormalise rectangles. */
  width: z.number().positive(),
  height: z.number().positive(),
  text: z.string(),
  runs: z.array(TextRunSchema),
});
export type PageText = z.infer<typeof PageTextSchema>;

export const IngestedDocumentSchema = z.object({
  id: z.string(),
  kind: z.enum(DOCUMENT_KINDS),
  filename: z.string(),
  byteLength: z.number().int().nonnegative(),
  /** SHA-256 of the stored bytes. Used to prove the original is never mutated. */
  sha256: z.string(),
  pageCount: z.number().int().nonnegative(),
  pages: z.array(PageTextSchema),
  /** All page text joined with form feeds, for prompting. */
  fullText: z.string(),
  createdAt: z.string(),
});
export type IngestedDocument = z.infer<typeof IngestedDocumentSchema>;

/** Metadata-only view, for listings where page text would be wasteful. */
export const DocumentSummarySchema = IngestedDocumentSchema.omit({
  pages: true,
  fullText: true,
});
export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;
