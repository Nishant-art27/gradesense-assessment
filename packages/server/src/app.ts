import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  CreateAnnotationSchema,
  DOCUMENT_KINDS,
  GradeRequestSchema,
  UpdateAnnotationSchema,
  type Annotation,
  type DocumentKind,
  type IngestedDocument,
} from '@gradesense/shared';
import { config } from './config.js';
import {
  AppError,
  NotFoundError,
  UnsupportedFileError,
  ValidationError,
  toApiError,
} from './errors.js';
import { buildAnnotatedPdf } from './export/annotate.js';
import { runGrading } from './grading/pipeline.js';
import type { GradingModel } from './grading/model.js';
import { createGradingModel } from './grading/provider-factory.js';
import { extractPdf, looksLikePdf } from './ingest/pdf.js';
import { loadRubric } from './rubric-source.js';
import { JsonFileRepository, type Repository } from './store/repository.js';

export interface AppDependencies {
  repository: Repository;
  /** Injectable so tests can substitute a misbehaving provider. */
  model?: GradingModel;
}

/** Express 4 does not forward rejected promises, so every async route goes through this. */
function asyncHandler(
  handler: (request: Request, response: Response) => Promise<unknown>,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    handler(request, response).catch(next);
  };
}

export function createApp(dependencies: AppDependencies): express.Express {
  const { repository } = dependencies;
  const model = dependencies.model ?? createGradingModel();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  /* ------------------------------- meta ---------------------------------- */

  app.get('/api/health', (_request, response) => {
    response.json({
      status: 'ok',
      provider: model.providerName,
      model: model.modelName,
      /** True when marks come from a real model rather than the rule-based mock. */
      live: model.providerName === 'anthropic',
    });
  });

  app.get(
    '/api/rubric',
    asyncHandler(async (_request, response) => {
      response.json(await loadRubric());
    }),
  );

  /* ----------------------------- documents ------------------------------- */

  /**
   * Upload is a raw PDF body rather than multipart. The client always sends a
   * single file, so multipart parsing would be a dependency and a class of edge
   * cases bought for nothing.
   */
  app.post(
    '/api/documents',
    express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: config.uploads.maxBytes }),
    asyncHandler(async (request, response) => {
      const kind = String(request.query.kind ?? '');
      if (!DOCUMENT_KINDS.includes(kind as DocumentKind)) {
        throw new ValidationError(
          `"kind" must be one of: ${DOCUMENT_KINDS.join(', ')}.`,
          [`Received "${kind}".`],
        );
      }

      const bytes = request.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new ValidationError(
          'The request body was empty. Send the PDF bytes with Content-Type: application/pdf.',
        );
      }
      if (!looksLikePdf(bytes)) {
        throw new UnsupportedFileError('That file is not a PDF. Only PDF answer papers are supported.');
      }

      const filename = sanitiseFilename(String(request.query.filename ?? 'upload.pdf'));
      const document = await ingest(bytes, kind as DocumentKind, filename);
      await repository.saveDocument(document, bytes);

      response.status(201).json(summarise(document));
    }),
  );

  app.get(
    '/api/documents',
    asyncHandler(async (_request, response) => {
      response.json(await repository.listDocuments());
    }),
  );

  app.get(
    '/api/documents/:id',
    asyncHandler(async (request, response) => {
      const document = await repository.requireDocument(request.params.id!);
      response.json(document);
    }),
  );

  /** Serves the stored original so the browser viewer can render it. */
  app.get(
    '/api/documents/:id/file',
    asyncHandler(async (request, response) => {
      const id = request.params.id!;
      const document = await repository.requireDocument(id);
      const bytes = await repository.getDocumentBytes(id);

      response.setHeader('Content-Type', 'application/pdf');
      response.setHeader('Content-Disposition', `inline; filename="${document.filename}"`);
      response.send(bytes);
    }),
  );

  /**
   * Loads the authored sample set in one call: question paper, model answer and
   * a chosen student answer. Exists so a reviewer can get to a graded paper in
   * two clicks instead of hunting for three files.
   */
  app.post(
    '/api/samples',
    asyncHandler(async (request, response) => {
      const requested = typeof request.body?.answer === 'string' ? request.body.answer : 'student-answer';
      const slug = sanitiseFilename(requested).replace(/\.pdf$/i, '');

      const answerPath = path.join(config.paths.answers, `${slug}.pdf`);
      const available = await listSampleSlugs();
      if (!available.includes(slug)) {
        throw new NotFoundError(
          `No sample answer called "${slug}". Available: ${available.join(', ') || 'none — run `npm run seed`'}.`,
        );
      }

      const loaded: Record<string, unknown> = {};

      const studentBytes = await fs.readFile(answerPath);
      const studentDocument = await ingest(studentBytes, 'student_answer', `${slug}.pdf`);
      await repository.saveDocument(studentDocument, studentBytes);
      loaded.studentAnswer = summarise(studentDocument);

      // The provided question paper and marking scheme live at the repo root.
      for (const [key, file, kind] of [
        ['questionPaper', 'GradeSense QP.pdf', 'question_paper'],
        ['modelAnswer', 'GradeSense MA.pdf', 'model_answer'],
      ] as const) {
        const filePath = path.join(config.paths.repoRoot, file);
        try {
          const bytes = await fs.readFile(filePath);
          const document = await ingest(bytes, kind, file);
          await repository.saveDocument(document, bytes);
          loaded[key] = summarise(document);
        } catch {
          // Not fatal: grading needs the student answer and the rubric, not these.
          loaded[key] = null;
        }
      }

      response.status(201).json(loaded);
    }),
  );

  app.get(
    '/api/samples',
    asyncHandler(async (_request, response) => {
      response.json({ answers: await listSampleSlugs() });
    }),
  );

  /* ------------------------------ grading -------------------------------- */

  app.post(
    '/api/grade',
    asyncHandler(async (request, response) => {
      const parsed = GradeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(
          'Invalid grading request.',
          parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        );
      }

      const rubric = await loadRubric();
      const studentDocument = await repository.requireDocument(parsed.data.studentAnswerDocumentId);
      if (studentDocument.kind !== 'student_answer') {
        throw new ValidationError(
          `Document "${studentDocument.id}" is a ${studentDocument.kind}, not a student answer.`,
        );
      }
      const studentPdfBytes = await repository.getDocumentBytes(studentDocument.id);

      const { result, annotations } = await runGrading({
        rubric,
        studentDocument,
        studentPdfBytes,
        questionPaperDocumentId: parsed.data.questionPaperDocumentId ?? null,
        modelAnswerDocumentId: parsed.data.modelAnswerDocumentId ?? null,
        model,
      });

      await repository.saveResult(result, annotations);
      response.status(201).json({ result, annotations });
    }),
  );

  app.get(
    '/api/results',
    asyncHandler(async (_request, response) => {
      response.json(await repository.listResults());
    }),
  );

  app.get(
    '/api/results/:id',
    asyncHandler(async (request, response) => {
      const id = request.params.id!;
      const result = await repository.requireResult(id);
      const annotations = await repository.getAnnotations(id);
      response.json({ result, annotations });
    }),
  );

  /* ---------------------------- annotations ------------------------------ */
  /*
   * These three routes are the "editable output" requirement. None of them can
   * change a mark, and none of them re-runs grading: they read and write the
   * annotation collection only. A teacher can drag a box, retype a correction or
   * delete a wrong note, and the marks stay exactly as they were.
   */

  app.post(
    '/api/results/:id/annotations',
    asyncHandler(async (request, response) => {
      const resultId = request.params.id!;
      await repository.requireResult(resultId);

      const parsed = CreateAnnotationSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(
          'Invalid annotation.',
          parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        );
      }

      const now = new Date().toISOString();
      const annotation: Annotation = {
        id: crypto.randomUUID(),
        resultId,
        questionId: parsed.data.questionId ?? null,
        criterionId: parsed.data.criterionId ?? null,
        kind: parsed.data.kind,
        severity: parsed.data.severity,
        rect: parsed.data.rect,
        extraRects: [],
        comment: parsed.data.comment,
        correction: parsed.data.correction ?? null,
        quote: null,
        // A teacher drew this box, so its position is authoritative by definition.
        anchorStatus: 'exact',
        origin: 'human',
        editedByHuman: true,
        createdAt: now,
        updatedAt: now,
      };

      response.status(201).json(await repository.addAnnotation(annotation));
    }),
  );

  app.patch(
    '/api/results/:id/annotations/:annotationId',
    asyncHandler(async (request, response) => {
      const parsed = UpdateAnnotationSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(
          'Invalid annotation update.',
          parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        );
      }

      const patch: Partial<Annotation> = {};
      if (parsed.data.rect !== undefined) {
        patch.rect = parsed.data.rect;
        // A moved annotation's original multi-line boxes no longer describe it.
        patch.extraRects = [];
      }
      if (parsed.data.comment !== undefined) patch.comment = parsed.data.comment;
      if (parsed.data.correction !== undefined) patch.correction = parsed.data.correction ?? null;
      if (parsed.data.kind !== undefined) patch.kind = parsed.data.kind;
      if (parsed.data.severity !== undefined) patch.severity = parsed.data.severity;

      const updated = await repository.updateAnnotation(
        request.params.id!,
        request.params.annotationId!,
        patch,
      );
      response.json(updated);
    }),
  );

  app.delete(
    '/api/results/:id/annotations/:annotationId',
    asyncHandler(async (request, response) => {
      await repository.deleteAnnotation(request.params.id!, request.params.annotationId!);
      response.status(204).end();
    }),
  );

  /* ------------------------------- export -------------------------------- */

  app.post(
    '/api/results/:id/export',
    asyncHandler(async (request, response) => {
      const resultId = request.params.id!;
      const result = await repository.requireResult(resultId);
      const annotations = await repository.getAnnotations(resultId);
      const originalBytes = await repository.getDocumentBytes(result.studentAnswerDocumentId);

      const annotated = await buildAnnotatedPdf({ originalBytes, result, annotations });

      const base = result.studentAnswerFilename.replace(/\.pdf$/i, '');
      response.setHeader('Content-Type', 'application/pdf');
      response.setHeader('Content-Disposition', `attachment; filename="${base}-annotated.pdf"`);
      response.send(annotated);
    }),
  );

  /* ------------------------------- errors -------------------------------- */

  app.use((_request, response) => {
    response.status(404).json(toApiError(new NotFoundError('No such endpoint.')).body);
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (!(error instanceof AppError)) {
      // Unexpected failures are logged in full but reported without internals.
      console.error('[api] Unhandled error:', error);
    }

    // Express's own body-parser errors arrive here; translate the useful ones.
    if (isPayloadTooLarge(error)) {
      const tooLarge = new UnsupportedFileError(
        `That file is larger than the ${Math.round(config.uploads.maxBytes / 1024 / 1024)} MB limit.`,
      );
      const { status, body } = toApiError(tooLarge);
      response.status(status).json(body);
      return;
    }

    const { status, body } = toApiError(error);
    response.status(status).json(body);
  });

  return app;

  /* ------------------------------ helpers -------------------------------- */

  async function ingest(bytes: Buffer, kind: DocumentKind, filename: string): Promise<IngestedDocument> {
    const extracted = await extractPdf(bytes);
    return {
      id: crypto.randomUUID(),
      kind,
      filename,
      byteLength: bytes.length,
      sha256: extracted.sha256,
      pageCount: extracted.pageCount,
      pages: extracted.pages,
      fullText: extracted.fullText,
      createdAt: new Date().toISOString(),
    };
  }
}

function summarise(document: IngestedDocument) {
  const { pages: _pages, fullText: _fullText, ...summary } = document;
  return summary;
}

/** Strips any path components, so a filename can never escape its directory. */
function sanitiseFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ]/g, '_').trim();
  return base.length > 0 ? base.slice(0, 120) : 'upload.pdf';
}

async function listSampleSlugs(): Promise<string[]> {
  try {
    const entries = await fs.readdir(config.paths.answers);
    return entries.filter((entry) => entry.endsWith('.pdf')).map((entry) => entry.replace(/\.pdf$/i, '')).sort();
  } catch {
    return [];
  }
}

function isPayloadTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { type?: string }).type === 'entity.too.large'
  );
}

export function createDefaultRepository(): Repository {
  return new JsonFileRepository(config.paths.data);
}
