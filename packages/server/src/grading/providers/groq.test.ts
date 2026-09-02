import { describe, expect, it } from 'vitest';
import { CRITERIA_JSON_SCHEMA } from '../../rubric/infer-criteria.js';
import { buildQuestionPrompt } from '../model.js';
import {
  ANSWER_CHUNK_JSON_SCHEMA,
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
});
