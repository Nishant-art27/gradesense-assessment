import { describe, expect, it } from 'vitest';
import { QUESTION_GRADING_JSON_SCHEMA, RUBRIC_JSON_SCHEMA } from '../output-schema.js';
import { toGeminiSchema } from './gemini.js';

/**
 * Gemini accepts JSON Schema but not quite the dialect the Anthropic path uses.
 * Rather than keep a second copy of every schema — which would drift — the
 * schema is converted at the boundary. These tests hold the conversion honest,
 * because a silently wrong schema means a 400 on every request with a real key,
 * which is exactly the failure a keyless test suite would otherwise never see.
 */

function walk(node: unknown, visit: (value: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((entry) => walk(entry, visit));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  visit(node as Record<string, unknown>);
  Object.values(node as Record<string, unknown>).forEach((value) => walk(value, visit));
}

describe('converting our schemas for Gemini', () => {
  const converted = [
    ['question grading', toGeminiSchema(QUESTION_GRADING_JSON_SCHEMA)],
    ['rubric extraction', toGeminiSchema(RUBRIC_JSON_SCHEMA)],
  ] as const;

  it.each(converted)('leaves no union types in the %s schema', (_name, schema) => {
    walk(schema, (node) => {
      if ('type' in node) expect(Array.isArray(node.type)).toBe(false);
    });
  });

  it.each(converted)('drops additionalProperties from the %s schema', (_name, schema) => {
    walk(schema, (node) => {
      expect(node).not.toHaveProperty('additionalProperties');
    });
  });

  it('turns a nullable union into type + nullable', () => {
    const out = toGeminiSchema({
      type: 'object',
      additionalProperties: false,
      required: ['quote'],
      properties: {
        quote: { type: ['string', 'null'], description: 'A quote, or null.' },
      },
    }) as Record<string, any>;

    expect(out.properties.quote).toEqual({
      type: 'string',
      nullable: true,
      description: 'A quote, or null.',
    });
    expect(out).not.toHaveProperty('additionalProperties');
    // Everything that is not one of those two differences survives untouched.
    expect(out.required).toEqual(['quote']);
  });

  it('keeps required, enums and descriptions intact', () => {
    const schema = toGeminiSchema(QUESTION_GRADING_JSON_SCHEMA) as Record<string, any>;

    expect(schema.required).toEqual([
      'questionId',
      'criteria',
      'findings',
      'summary',
      'selfConfidence',
    ]);

    const status = schema.properties.criteria.items.properties.status;
    expect(status.enum).toContain('correct');
    expect(status.enum).toContain('incorrect');

    const evidence = schema.properties.criteria.items.properties.evidenceQuote;
    expect(evidence.nullable).toBe(true);
    expect(evidence.description).toMatch(/verbatim/i);
  });

  it('is a pure transform — the source schema is not mutated', () => {
    const before = JSON.stringify(QUESTION_GRADING_JSON_SCHEMA);
    toGeminiSchema(QUESTION_GRADING_JSON_SCHEMA);
    expect(JSON.stringify(QUESTION_GRADING_JSON_SCHEMA)).toBe(before);
  });
});
