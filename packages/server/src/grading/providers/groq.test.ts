import { describe, expect, it } from 'vitest';
import { CRITERIA_JSON_SCHEMA } from '../../rubric/infer-criteria.js';
import { SYSTEM_PROMPT, buildQuestionPrompt } from '../model.js';
import {
  ANSWER_CHUNK_JSON_SCHEMA,
  PAGE_TRANSCRIPT_JSON_SCHEMA,
  QUESTION_GRADING_JSON_SCHEMA,
  QUESTION_PAPER_CHUNK_JSON_SCHEMA,
  RUBRIC_JSON_SCHEMA,
  SCHEME_CHUNK_JSON_SCHEMA,
} from '../output-schema.js';
import { GroqGradingModel } from './groq.js';

/**
 * Groq takes our JSON Schema with no adapter in between, which is only safe
 * while the schema keeps satisfying strict mode: every property listed in
 * `required`, and `additionalProperties: false` on every object.
 *
 * Nothing in the keyless test suite would otherwise notice a drift. The symptom
 * with a real key is a 400 on every single request — so the invariant is
 * asserted here instead, where it fails in CI rather than in front of a teacher.
 */

interface SchemaNode {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown;
  additionalProperties?: unknown;
  items?: unknown;
}

/** Every object node in a schema, with a path for a legible failure message. */
function objectNodes(schema: unknown, path = '(root)'): Array<[string, SchemaNode]> {
  if (Array.isArray(schema)) return schema.flatMap((entry, i) => objectNodes(entry, `${path}[${i}]`));
  if (typeof schema !== 'object' || schema === null) return [];

  const node = schema as SchemaNode;
  const found: Array<[string, SchemaNode]> = [];

  const isObjectSchema =
    node.properties !== undefined &&
    (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object')));
  if (isObjectSchema) found.push([path, node]);

  for (const [key, value] of Object.entries(node.properties ?? {})) {
    found.push(...objectNodes(value, `${path}.${key}`));
  }
  if (node.items !== undefined) found.push(...objectNodes(node.items, `${path}[]`));

  return found;
}

const SCHEMAS = [
  ['question grading', QUESTION_GRADING_JSON_SCHEMA],
  ['rubric extraction', RUBRIC_JSON_SCHEMA],
  ['criteria inference', CRITERIA_JSON_SCHEMA],
  ['question paper chunk', QUESTION_PAPER_CHUNK_JSON_SCHEMA],
  ['marking scheme chunk', SCHEME_CHUNK_JSON_SCHEMA],
  ['answer sheet chunk', ANSWER_CHUNK_JSON_SCHEMA],
  ['page transcript', PAGE_TRANSCRIPT_JSON_SCHEMA],
] as const;

describe('the schemas Groq is sent, under strict mode', () => {
  it.each(SCHEMAS)('lists every property of every object as required in %s', (_name, schema) => {
    for (const [path, node] of objectNodes(schema)) {
      const properties = Object.keys(node.properties ?? {}).sort();
      const required = [...((node.required as string[] | undefined) ?? [])].sort();
      expect(required, `${path} must require every property`).toEqual(properties);
    }
  });

  it.each(SCHEMAS)('sets additionalProperties false on every object in %s', (_name, schema) => {
    for (const [path, node] of objectNodes(schema)) {
      expect(node.additionalProperties, `${path} must forbid extra properties`).toBe(false);
    }
  });

  it('finds the object nodes it claims to check', () => {
    // Guards the guard: a walker that silently matched nothing would make every
    // assertion above vacuously true.
    expect(objectNodes(QUESTION_GRADING_JSON_SCHEMA).length).toBeGreaterThan(3);
  });
});

describe('what the grader tells the model it can see', () => {
  const question = {
    id: 'q1',
    number: 1,
    subject: 'Science',
    prompt: 'Describe a simple circuit and draw it.',
    maxMarks: 5,
    modelAnswer: 'A closed conducting path.',
    guidance: [],
    requiresDiagram: true,
    criteriaSource: 'instructor' as const,
    criteria: [{ id: 'q1c1', description: 'Defines a closed path', maxMarks: 1 }],
  };
  const base = {
    question,
    answerText: 'A circuit is a closed path.',
    pdfBase64: null,
    pageCount: 1,
    startPage: 0,
    pages: [],
  };

  /*
   * Groq's chat API takes text, not PDFs. Telling a model that the answer sheet
   * is attached when it is not invites it to describe a drawing it cannot see
   * and award marks for it — a confident, unfalsifiable wrong mark.
   */
  it('never claims a PDF is attached when none was sent', () => {
    const prompt = buildQuestionPrompt(base);

    expect(prompt).not.toMatch(/attached PDF/i);
    expect(prompt).toMatch(/CANNOT see it/);
    expect(prompt).toMatch(/Never describe a drawing you have not seen/i);
  });

  it('still says the sheet is attached when it really is', () => {
    const prompt = buildQuestionPrompt({ ...base, pdfBase64: 'JVBERi0=' });

    expect(prompt).toMatch(/attached PDF/i);
    expect(prompt).not.toMatch(/CANNOT see it/);
  });

  it('tells a text-only model to lower its confidence rather than guess', () => {
    expect(buildQuestionPrompt(base)).toMatch(/low selfConfidence/i);
  });

  it('says the layout is invisible even when no diagram is marked', () => {
    const prompt = buildQuestionPrompt({
      ...base,
      question: { ...question, requiresDiagram: false },
    });

    expect(prompt).not.toMatch(/attached PDF/i);
    expect(prompt).toMatch(/not the sheet itself/i);
  });

  /*
   * A scanned sheet reaches a text-only model as a vision model's transcript.
   * The grader has to know that — a transcript can be wrong where the student
   * was right — and has to know what the markers in it mean.
   */
  it('explains a transcript and its markers to a model that cannot see the page', () => {
    const prompt = buildQuestionPrompt({
      ...base,
      answerText: 'Q1\n[Diagram 1: a loop with a cell and a bulb. Labels: cell | bulb]\nA circuit is a [unclear: closed] path.',
      answerSource: 'transcription',
      transcriptionNotes: { legibility: 'fair', unclear: ['closed'] },
    });

    expect(prompt).toMatch(/TRANSCRIPTION of scanned handwriting/);
    expect(prompt).toMatch(/CANNOT see the page/);
    expect(prompt).toMatch(/\[Diagram N: …\]/);
    expect(prompt).toMatch(/\[unclear: …\]/);
    expect(prompt).toMatch(/\[struck: …\]/);
    expect(prompt).toMatch(/legibility as "fair"/);
    expect(prompt).toMatch(/"closed"/);
    expect(prompt).toMatch(/Never describe a drawing you have not seen/i);
    expect(prompt).not.toMatch(/attached PDF/i);
  });

  it('makes the page image authoritative over the transcript when both are sent', () => {
    const prompt = buildQuestionPrompt({ ...base, pdfBase64: 'JVBERi0=', answerSource: 'transcription' });

    expect(prompt).toMatch(/attached PDF is the scanned answer sheet itself and is authoritative/);
    expect(prompt).toMatch(/believe the page/);
    expect(prompt).not.toMatch(/CANNOT see/);
  });

  it('tells the examiner how to read handwriting in every request', () => {
    expect(SYSTEM_PROMPT).toMatch(/IMAGE is authoritative/);
    expect(SYSTEM_PROMPT).toMatch(/Distinguish a transcription error from a student error/);
    expect(SYSTEM_PROMPT).toMatch(/Do not invent content/);
    expect(SYSTEM_PROMPT).toMatch(/Mark against the MARKING SCHEME, not against similarity/);
    expect(SYSTEM_PROMPT).toMatch(/Do not penalise a student for the quality of their handwriting/);
  });
});

describe('the Groq provider', () => {
  it('reports itself as groq, and uses the model it was given', () => {
    const model = new GroqGradingModel('openai/gpt-oss-120b', 'test-key');

    expect(model.providerName).toBe('groq');
    expect(model.modelName).toBe('openai/gpt-oss-120b');
  });

  it('can read a scheme and infer criteria, like the other live providers', () => {
    const model = new GroqGradingModel('openai/gpt-oss-120b', 'test-key');

    expect(typeof model.extractRubric).toBe('function');
    expect(typeof model.inferCriteria).toBe('function');
  });

  it('reads scanned pages only when a vision model is configured', () => {
    const withVision = new GroqGradingModel('openai/gpt-oss-120b', 'test-key', undefined, undefined, 'qwen/qwen3.8-27b');
    const without = new GroqGradingModel('openai/gpt-oss-120b', 'test-key', undefined, undefined, null);

    expect(typeof withVision.transcribePage).toBe('function');
    expect(withVision.visionModelName).toBe('qwen/qwen3.8-27b');
    expect(without.transcribePage).toBeUndefined();
  });
});

describe('how long Groq asks us to wait after a refusal', () => {
  it('reads retry-after in seconds, from either header shape', async () => {
    const { retryAfterMs } = await import('./groq.js');
    expect(retryAfterMs({ headers: new Headers({ 'retry-after': '23' }) })).toBe(23_000);
    expect(retryAfterMs({ headers: { 'retry-after': '7.5' } })).toBe(7_500);
  });

  it('falls back to the token window reset, and to null when Groq says nothing', async () => {
    const { retryAfterMs } = await import('./groq.js');
    expect(retryAfterMs({ headers: new Headers({ 'x-ratelimit-reset-tokens': '2m3.5s' }) })).toBe(123_500);
    expect(retryAfterMs({ headers: new Headers() })).toBeNull();
    expect(retryAfterMs({})).toBeNull();
  });
});
