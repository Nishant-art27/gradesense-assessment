import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IngestedDocument } from '@gradesense/shared';
import { config } from './config.js';
import { extractPdf } from './ingest/pdf.js';
import { JsonFileRepository } from './store/repository.js';

/**
 * Helpers shared by the test suite.
 *
 * The fixtures are the real authored answer papers, parsed by the real PDF
 * ingest path. Tests could run against hand-written strings far faster, but then
 * they would not exercise text extraction, coordinate mapping or quote anchoring
 * — which is where the interesting failures live.
 */

/** Parsed fixtures are cached: extraction is the slow part and the files never change. */
const cache = new Map<string, { document: IngestedDocument; bytes: Buffer }>();

export type AnswerSlug =
  | 'student-answer'
  | 'fully-correct'
  | 'incorrect'
  | 'blank'
  | 'ocr-errors';

export function answerFixturePath(slug: AnswerSlug): string {
  return path.join(config.paths.answers, `${slug}.pdf`);
}

export function fixturesExist(): boolean {
  return fs.existsSync(answerFixturePath('student-answer'));
}

export async function loadAnswerFixture(
  slug: AnswerSlug,
): Promise<{ document: IngestedDocument; bytes: Buffer }> {
  const cached = cache.get(slug);
  if (cached) return cached;

  const filePath = answerFixturePath(slug);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Missing fixture ${filePath}. Run \`npm run seed\` to generate the answer papers before running the tests.`,
    );
  }

  const bytes = await fsp.readFile(filePath);
  const extracted = await extractPdf(bytes);

  const document: IngestedDocument = {
    id: crypto.randomUUID(),
    kind: 'student_answer',
    filename: `${slug}.pdf`,
    byteLength: bytes.length,
    sha256: extracted.sha256,
    pageCount: extracted.pageCount,
    pages: extracted.pages,
    fullText: extracted.fullText,
    createdAt: new Date().toISOString(),
  };

  const entry = { document, bytes };
  cache.set(slug, entry);
  return entry;
}

export interface TempRepository {
  repository: JsonFileRepository;
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * A real repository pointed at a throwaway directory.
 *
 * Deliberately not an in-memory fake: the store's atomic write path and its
 * separation of annotations from results are behaviour the tests are asserting,
 * so they should run against the code that actually ships.
 */
export async function createTempRepository(): Promise<TempRepository> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gradesense-test-'));
  return {
    repository: new JsonFileRepository(dir),
    dir,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true }),
  };
}

export function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
