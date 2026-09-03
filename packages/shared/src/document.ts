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

/**
 * Where a page's text came from.
 *
 * `text-layer` — read from the PDF itself, with a rectangle for every run.
 * `transcription` — a scanned page with no text layer, read by a vision model
 *   from the page image. Faithful to what was written, but without positions,
 *   so annotations on it fall back to margin notes.
 */
export const PAGE_TEXT_SOURCES = ['text-layer', 'transcription'] as const;
export type PageTextSource = (typeof PAGE_TEXT_SOURCES)[number];

export const PageTextSchema = z.object({
  index: z.number().int().nonnegative(),
  /** Page dimensions in PDF points, kept so exports can denormalise rectangles. */
  width: z.number().positive(),
  height: z.number().positive(),
  text: z.string(),
  runs: z.array(TextRunSchema),
  /** Absent on documents stored before transcription existed; means text-layer. */
  source: z.enum(PAGE_TEXT_SOURCES).optional(),
});

/**
 * What happened to a document's pages that had no text layer.
 *
 * `pending` — a vision model is reading them in the background.
 * `done` — the pages now carry transcribed text.
 * `unsupported` — the provider cannot read images, so the pages stay blank and
 *   every result built on them says so.
 * `failed` — transcription was attempted and did not complete.
 */
export const TRANSCRIPTION_STATUSES = ['pending', 'done', 'unsupported', 'failed'] as const;
export type TranscriptionStatus = (typeof TRANSCRIPTION_STATUSES)[number];

export const TranscriptionInfoSchema = z.object({
  status: z.enum(TRANSCRIPTION_STATUSES),
  /** Zero-based indices of the pages that needed (or need) transcription. */
  pages: z.array(z.number().int().nonnegative()),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  at: z.string().nullable(),
  /** The transcriber's own reading of how legible the handwriting was. */
  legibility: z.enum(['good', 'fair', 'poor']).nullable(),
  /** Spans the transcriber could not read with confidence, verbatim from its markers. */
  unclear: z.array(z.string()),
  error: z.string().nullable(),
});
export type TranscriptionInfo = z.infer<typeof TranscriptionInfoSchema>;
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
  /** Present only for documents with pages that had no text layer. */
  transcription: TranscriptionInfoSchema.optional(),
});
export type IngestedDocument = z.infer<typeof IngestedDocumentSchema>;

/** Metadata-only view, for listings where page text would be wasteful. */
export const DocumentSummarySchema = IngestedDocumentSchema.omit({
  pages: true,
  fullText: true,
});
export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;
