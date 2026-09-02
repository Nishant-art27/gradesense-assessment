/**
 * Marks one paper with whichever real provider is configured, and prints what
 * came back.
 *
 * The test suite runs entirely on the deterministic mock, which is what makes it
 * keyless and reproducible — but that means nothing in CI ever exercises a real
 * API. This script is the missing half: it proves a key works, the schema is
 * accepted, and the marks land somewhere sensible.
 *
 *   MODEL_PROVIDER=groq GROQ_API_KEY=... npx tsx scripts/check-provider.ts
 *   MODEL_PROVIDER=groq npx tsx scripts/check-provider.ts fully-correct
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../packages/server/src/config.js';
import { extractPdf } from '../packages/server/src/ingest/pdf.js';
import { runGrading } from '../packages/server/src/grading/pipeline.js';
import { createGradingModel } from '../packages/server/src/grading/provider-factory.js';
import { loadRubric } from '../packages/server/src/rubric-source.js';
import type { IngestedDocument } from '../packages/shared/src/index.js';

const slug = process.argv[2] ?? 'student-answer';

if (config.provider === 'mock') {
  console.error(
    '\nThis check is for a real provider, but the mock is active.\n' +
      'Run it with a key, for example:\n' +
      '  MODEL_PROVIDER=groq GROQ_API_KEY=... npx tsx scripts/check-provider.ts\n',
  );
  process.exit(1);
}

const model = createGradingModel();
console.log(`\nProvider : ${model.providerName}`);
console.log(`Model    : ${model.modelName}`);
console.log(`Paper    : ${slug}.pdf\n`);

const rubric = await loadRubric();
const file = path.join(config.paths.answers, `${slug}.pdf`);
const bytes = fs.readFileSync(file);
const extracted = await extractPdf(bytes);

const studentDocument: IngestedDocument = {
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

const started = Date.now();
const { result, annotations } = await runGrading({ rubric, studentDocument, studentPdfBytes: bytes, model });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`TOTAL ${result.totalMarks}/${result.maxMarks}   confidence ${(result.confidence * 100).toFixed(0)}%   review=${result.requiresHumanReview}   ${seconds}s\n`);

for (const question of result.questions) {
  console.log(`Q${question.number} ${question.subject} — ${question.awardedMarks}/${question.maxMarks} [${question.state}]`);
  for (const criterion of question.criteria) {
    const verified = criterion.evidence
      ? criterion.evidence.verified
        ? 'evidence ok'
        : 'EVIDENCE NOT FOUND'
      : 'no quote';
    console.log(`   ${criterion.criterionId}  ${criterion.awardedMarks}/${criterion.maxMarks}  ${criterion.status.padEnd(9)} ${verified}`);
  }
  console.log();
}

/*
 * Quotes the model cited that are not actually in the answer.
 *
 * This is the single most useful signal when judging a provider: a model that
 * paraphrases instead of copying will look fine on marks and still be unable to
 * show a teacher where a judgement came from.
 */
const unverified = result.questions
  .flatMap((question) => question.criteria)
  .filter((criterion) => criterion.evidence && !criterion.evidence.verified);

if (unverified.length > 0) {
  console.log(`Evidence that could not be found in the answer (${unverified.length}):\n`);
  for (const criterion of unverified) {
    console.log(`   ${criterion.criterionId}  cited: ${JSON.stringify(criterion.evidence!.quote)}`);
    console.log(`               best match similarity: ${criterion.evidence!.similarity}\n`);
  }
}

const anchors = annotations.reduce<Record<string, number>>((acc, annotation) => {
  acc[annotation.anchorStatus] = (acc[annotation.anchorStatus] ?? 0) + 1;
  return acc;
}, {});
console.log(`Annotations: ${annotations.length}`, anchors);

if (result.audit.length > 0) {
  console.log('\nCorrections the pipeline applied to the model output:');
  for (const event of result.audit) {
    console.log(`   ${event.kind}${event.before !== null ? ` ${event.before} -> ${event.after}` : ''}`);
  }
}

if (result.reviewReasons.length > 0) {
  console.log('\nFlagged for review because:');
  for (const reason of result.reviewReasons) console.log(`   - ${reason}`);
}
console.log();
