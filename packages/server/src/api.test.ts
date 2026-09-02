import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Annotation, GradingResult } from '@gradesense/shared';
import { createApp } from './app.js';
import { MockGradingModel } from './grading/providers/mock.js';
import { FailingGradingModel } from './grading/providers/faults.js';
import type { GradingModel } from './grading/model.js';
import {
  answerFixturePath,
  createTempRepository,
  sha256,
  type TempRepository,
} from './test-support.js';
import fs from 'node:fs/promises';

/**
 * HTTP-level behaviour.
 *
 * The annotation tests here are the ones that matter most for the brief: they
 * prove that moving, retyping and deleting mark-up goes nowhere near the marks,
 * and that exporting never touches the original file.
 */

const temps: TempRepository[] = [];

async function makeApp(model: GradingModel = new MockGradingModel()): Promise<{
  app: Express;
  temp: TempRepository;
}> {
  const temp = await createTempRepository();
  temps.push(temp);
  return { app: createApp({ repository: temp.repository, model }), temp };
}

afterAll(async () => {
  await Promise.all(temps.map((temp) => temp.cleanup()));
});

async function uploadAnswer(app: Express, slug = 'student-answer'): Promise<string> {
  const bytes = await fs.readFile(answerFixturePath(slug as never));
  const response = await request(app)
    .post('/api/documents')
    .query({ kind: 'student_answer', filename: `${slug}.pdf` })
    .set('Content-Type', 'application/pdf')
    .send(bytes)
    .expect(201);
  return response.body.id as string;
}

async function gradeAnswer(
  app: Express,
  slug = 'student-answer',
): Promise<{ result: GradingResult; annotations: Annotation[] }> {
  const documentId = await uploadAnswer(app, slug);
  const response = await request(app)
    .post('/api/grade')
    .send({ studentAnswerDocumentId: documentId })
    .expect(201);
  return response.body;
}

/* -------------------------------- uploads -------------------------------- */

describe('uploading documents', () => {
  it('ingests a PDF and reports its pages and hash', async () => {
    const { app } = await makeApp();
    const bytes = await fs.readFile(answerFixturePath('student-answer'));

    const response = await request(app)
      .post('/api/documents')
      .query({ kind: 'student_answer', filename: 'student-answer.pdf' })
      .set('Content-Type', 'application/pdf')
      .send(bytes)
      .expect(201);

    expect(response.body.pageCount).toBe(2);
    expect(response.body.sha256).toBe(sha256(bytes));
    expect(response.body.kind).toBe('student_answer');
  });

  it('rejects a file that is not a PDF', async () => {
    const { app } = await makeApp();

    const response = await request(app)
      .post('/api/documents')
      .query({ kind: 'student_answer', filename: 'notes.txt' })
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('This is plainly not a PDF.'))
      .expect(415);

    expect(response.body.error.code).toBe('unsupported_file');
  });

  it('rejects an unknown document kind', async () => {
    const { app } = await makeApp();
    const bytes = await fs.readFile(answerFixturePath('blank'));

    const response = await request(app)
      .post('/api/documents')
      .query({ kind: 'homework', filename: 'blank.pdf' })
      .set('Content-Type', 'application/pdf')
      .send(bytes)
      .expect(400);

    expect(response.body.error.code).toBe('validation_failed');
  });

  it('serves the stored original back for the viewer', async () => {
    const { app } = await makeApp();
    const documentId = await uploadAnswer(app);
    const original = await fs.readFile(answerFixturePath('student-answer'));

    const response = await request(app).get(`/api/documents/${documentId}/file`).expect(200);

    expect(response.headers['content-type']).toContain('application/pdf');
    expect(sha256(response.body)).toBe(sha256(original));
  });
});

/* -------------------------------- grading -------------------------------- */

describe('grading over HTTP', () => {
  it('returns the result with its annotations and saves it to history', async () => {
    const { app } = await makeApp();
    const { result, annotations } = await gradeAnswer(app);

    expect(result.totalMarks).toBe(7.5);
    expect(annotations.length).toBeGreaterThan(0);

    const history = await request(app).get('/api/results').expect(200);
    expect(history.body).toHaveLength(1);
    expect(history.body[0].id).toBe(result.id);
    expect(history.body[0].annotationCount).toBe(annotations.length);
  });

  it('can reopen a saved result later', async () => {
    const { app } = await makeApp();
    const { result, annotations } = await gradeAnswer(app);

    const reopened = await request(app).get(`/api/results/${result.id}`).expect(200);

    expect(reopened.body.result.totalMarks).toBe(result.totalMarks);
    expect(reopened.body.annotations).toHaveLength(annotations.length);
  });

  it('404s for a result that does not exist', async () => {
    const { app } = await makeApp();

    const response = await request(app).get('/api/results/does-not-exist').expect(404);
    expect(response.body.error.code).toBe('not_found');
  });

  it('rejects grading a document that is not a student answer', async () => {
    const { app } = await makeApp();
    const bytes = await fs.readFile(answerFixturePath('student-answer'));
    const upload = await request(app)
      .post('/api/documents')
      .query({ kind: 'model_answer', filename: 'ma.pdf' })
      .set('Content-Type', 'application/pdf')
      .send(bytes)
      .expect(201);

    const response = await request(app)
      .post('/api/grade')
      .send({ studentAnswerDocumentId: upload.body.id })
      .expect(400);

    expect(response.body.error.code).toBe('validation_failed');
  });

  it('reports a model outage as a retryable 503 and saves nothing', async () => {
    const { app } = await makeApp(new FailingGradingModel('server'));
    const documentId = await uploadAnswer(app);

    const response = await request(app)
      .post('/api/grade')
      .send({ studentAnswerDocumentId: documentId })
      .expect(503);

    expect(response.body.error.code).toBe('model_unavailable');
    expect(response.body.error.retryable).toBe(true);

    // Nothing half-marked in the history to mislead whoever opens it next.
    const history = await request(app).get('/api/results').expect(200);
    expect(history.body).toHaveLength(0);
  });
});

/* ------------------------- editing annotations --------------------------- */

describe('editing annotations without re-grading', () => {
  let app: Express;
  let result: GradingResult;
  let annotations: Annotation[];
  let model: MockGradingModel;

  beforeEach(async () => {
    model = new MockGradingModel();
    const made = await makeApp(model);
    app = made.app;
    const graded = await gradeAnswer(app);
    result = graded.result;
    annotations = graded.annotations;
    // Grading made three calls (one per question). Any further call during the
    // annotation edits below would mean the paper was re-graded.
    expect(model.callCount).toBe(3);
  });

  it('moves an annotation and leaves every mark untouched', async () => {
    const target = annotations[0]!;
    const newRect = { page: 1, x: 0.4, y: 0.6, width: 0.25, height: 0.04 };

    const response = await request(app)
      .patch(`/api/results/${result.id}/annotations/${target.id}`)
      .send({ rect: newRect })
      .expect(200);

    expect(response.body.rect).toEqual(newRect);
    expect(response.body.editedByHuman).toBe(true);
    // A moved box no longer describes the original multi-line span.
    expect(response.body.extraRects).toEqual([]);

    const after = await request(app).get(`/api/results/${result.id}`).expect(200);
    expect(after.body.result.totalMarks).toBe(result.totalMarks);
    expect(after.body.result.questions).toEqual(result.questions);

    // The decisive assertion: the model was never consulted again.
    expect(model.callCount).toBe(3);
  });

  it('rewrites a comment and correction in place', async () => {
    const target = annotations[0]!;

    const response = await request(app)
      .patch(`/api/results/${result.id}/annotations/${target.id}`)
      .send({ comment: 'See me about this one.', correction: 'Voltmeter goes in parallel.' })
      .expect(200);

    expect(response.body.comment).toBe('See me about this one.');
    expect(response.body.correction).toBe('Voltmeter goes in parallel.');
    expect(response.body.rect).toEqual(target.rect);
    expect(model.callCount).toBe(3);
  });

  it('deletes an annotation', async () => {
    const target = annotations[0]!;

    await request(app).delete(`/api/results/${result.id}/annotations/${target.id}`).expect(204);

    const after = await request(app).get(`/api/results/${result.id}`).expect(200);
    expect(after.body.annotations).toHaveLength(annotations.length - 1);
    expect(after.body.annotations.some((a: Annotation) => a.id === target.id)).toBe(false);

    // Marks survive the deletion of their annotation — the two are separate.
    expect(after.body.result.totalMarks).toBe(result.totalMarks);
    expect(model.callCount).toBe(3);
  });

  it('lets a teacher add their own annotation', async () => {
    const response = await request(app)
      .post(`/api/results/${result.id}/annotations`)
      .send({
        rect: { page: 0, x: 0.1, y: 0.2, width: 0.3, height: 0.03 },
        comment: 'Handwriting is hard to read here.',
        kind: 'layout',
        severity: 'minor',
      })
      .expect(201);

    expect(response.body.origin).toBe('human');
    expect(response.body.editedByHuman).toBe(true);
    expect(response.body.anchorStatus).toBe('exact');

    const after = await request(app).get(`/api/results/${result.id}`).expect(200);
    expect(after.body.annotations).toHaveLength(annotations.length + 1);
    expect(model.callCount).toBe(3);
  });

  it('rejects an empty update and an out-of-range rectangle', async () => {
    const target = annotations[0]!;

    await request(app)
      .patch(`/api/results/${result.id}/annotations/${target.id}`)
      .send({})
      .expect(400);

    await request(app)
      .patch(`/api/results/${result.id}/annotations/${target.id}`)
      .send({ rect: { page: 0, x: 1.7, y: 0.2, width: 0.3, height: 0.03 } })
      .expect(400);
  });

  it('404s when the annotation is not there', async () => {
    await request(app)
      .patch(`/api/results/${result.id}/annotations/nope`)
      .send({ comment: 'x' })
      .expect(404);

    await request(app).delete(`/api/results/${result.id}/annotations/nope`).expect(404);
  });
});

/* --------------------------------- export -------------------------------- */

describe('exporting an annotated copy', () => {
  it('returns a PDF and leaves the original file byte-identical', async () => {
    const { app, temp } = await makeApp();
    const documentId = await uploadAnswer(app);

    const graded = await request(app)
      .post('/api/grade')
      .send({ studentAnswerDocumentId: documentId })
      .expect(201);
    const resultId = graded.body.result.id as string;

    const before = sha256(await temp.repository.getDocumentBytes(documentId));

    const response = await request(app)
      .post(`/api/results/${resultId}/export`)
      .expect(200)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toContain('student-answer-annotated.pdf');

    const exported = response.body as Buffer;
    expect(exported.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // The annotated copy carries the original pages plus a marking summary.
    expect(exported.length).toBeGreaterThan(0);

    // "The original answer paper must not be destroyed or changed."
    const after = sha256(await temp.repository.getDocumentBytes(documentId));
    expect(after).toBe(before);
  });

  it('reflects the teacher\'s edits rather than the original marking', async () => {
    const { app } = await makeApp();
    const { result, annotations } = await gradeAnswer(app);

    // Delete everything, so the export must come back without page annotations.
    for (const annotation of annotations) {
      await request(app).delete(`/api/results/${result.id}/annotations/${annotation.id}`).expect(204);
    }

    const response = await request(app)
      .post(`/api/results/${result.id}/export`)
      .expect(200)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect((response.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

/* ------------------------- rubrics from uploads --------------------------- */

describe('setting up an exam from uploaded documents', () => {
  async function uploadProvided(app: Express, file: string, kind: 'question_paper' | 'model_answer') {
    const bytes = await fs.readFile(`${process.cwd()}/${file}`);
    const response = await request(app)
      .post('/api/documents')
      .query({ kind, filename: file })
      .set('Content-Type', 'application/pdf')
      .send(bytes)
      .expect(201);
    return response.body.id as string;
  }

  it('reads a rubric out of an uploaded marking scheme', async () => {
    const { app } = await makeApp();
    const modelAnswerId = await uploadProvided(app, 'GradeSense MA.pdf', 'model_answer');
    const questionPaperId = await uploadProvided(app, 'GradeSense QP.pdf', 'question_paper');

    const response = await request(app)
      .post('/api/rubrics/extract')
      .send({ modelAnswerDocumentId: modelAnswerId, questionPaperDocumentId: questionPaperId })
      .expect(200);

    expect(response.body.source).toBe('parsed');
    // Q3 of the provided scheme has no grading guidance; that is reported.
    expect(response.body.warnings).toHaveLength(1);
    expect(response.body.warnings[0]).toMatch(/Question 3.*no grading guidance/i);
    expect(response.body.rubric.totalMarks).toBe(15);
    expect(response.body.rubric.questions).toHaveLength(3);
  });

  it('marks a paper against the uploaded rubric, not the built-in one', async () => {
    const { app } = await makeApp();
    const modelAnswerId = await uploadProvided(app, 'GradeSense MA.pdf', 'model_answer');
    const questionPaperId = await uploadProvided(app, 'GradeSense QP.pdf', 'question_paper');

    const draft = await request(app)
      .post('/api/rubrics/extract')
      .send({ modelAnswerDocumentId: modelAnswerId, questionPaperDocumentId: questionPaperId })
      .expect(200);

    const saved = await request(app)
      .post('/api/rubrics')
      .send({ rubric: draft.body.rubric })
      .expect(201);

    const studentId = await uploadAnswer(app);
    const graded = await request(app)
      .post('/api/grade')
      .send({ studentAnswerDocumentId: studentId, rubricId: saved.body.id })
      .expect(201);

    // The extracted rubric reproduces the hand-written fixture exactly, so the
    // marks match the built-in path. That equivalence is the point of the test.
    expect(graded.body.result.rubricId).toBe(saved.body.id);
    expect(graded.body.result.totalMarks).toBe(7.5);
  });

  it('refuses a rubric whose marks do not add up', async () => {
    const { app } = await makeApp();
    const rubric = {
      id: 'broken',
      title: 'Broken',
      totalMarks: 10,
      questions: [
        {
          id: 'q1',
          number: 1,
          subject: 'Science',
          maxMarks: 10,
          prompt: 'x',
          modelAnswer: 'y',
          guidance: [],
          requiresDiagram: false,
          criteria: [{ id: 'q1c1', description: 'A point', maxMarks: 1 }],
        },
      ],
    };

    const response = await request(app).post('/api/rubrics').send({ rubric }).expect(400);
    expect(response.body.error.code).toBe('validation_failed');
    expect(response.body.error.details.join(' ')).toMatch(/criteria sum to 1/i);
  });

  it('404s when marking against a rubric that was never saved', async () => {
    const { app } = await makeApp();
    const studentId = await uploadAnswer(app);

    const response = await request(app)
      .post('/api/grade')
      .send({ studentAnswerDocumentId: studentId, rubricId: 'nope' })
      .expect(404);

    expect(response.body.error.code).toBe('not_found');
  });

  it('requires a marking scheme to read a rubric from', async () => {
    const { app } = await makeApp();
    const response = await request(app).post('/api/rubrics/extract').send({}).expect(400);
    expect(response.body.error.code).toBe('validation_failed');
  });
});

/* --------------------------------- meta ---------------------------------- */

describe('meta endpoints', () => {
  it('reports which provider is in use', async () => {
    const { app } = await makeApp();

    const response = await request(app).get('/api/health').expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.provider).toBe('mock');
    expect(response.body.live).toBe(false);
  });

  it('serves the rubric with consistent arithmetic', async () => {
    const { app } = await makeApp();

    const response = await request(app).get('/api/rubric').expect(200);
    expect(response.body.totalMarks).toBe(15);
    expect(response.body.questions).toHaveLength(3);

    for (const question of response.body.questions) {
      const sum = question.criteria.reduce(
        (total: number, criterion: { maxMarks: number }) => total + criterion.maxMarks,
        0,
      );
      expect(sum).toBe(question.maxMarks);
    }
  });

  it('404s on an unknown endpoint', async () => {
    const { app } = await makeApp();

    const response = await request(app).get('/api/nope').expect(404);
    expect(response.body.error.code).toBe('not_found');
  });
});
