import { describe, expect, it } from 'vitest';
import {
  CRITERION_STATUSES,
  FINDING_KINDS,
  ModelQuestionGradingSchema,
} from '@gradesense/shared';
import { QUESTION_GRADING_JSON_SCHEMA } from './output-schema.js';
import { parseModelOutput } from './validate.js';

/**
 * The model contract exists twice: as a JSON Schema sent to the API, and as the
 * Zod schema that validates what comes back. Two representations of one contract
 * can drift, and the failure mode is nasty — the API would happily accept output
 * that our own validator then rejects on every request.
 *
 * These tests keep them in step.
 */

function objectSchema(node: unknown): {
  required: string[];
  properties: Record<string, unknown>;
  additionalProperties: unknown;
} {
  const schema = node as {
    required?: string[];
    properties?: Record<string, unknown>;
    additionalProperties?: unknown;
  };
  return {
    required: schema.required ?? [],
    properties: schema.properties ?? {},
    additionalProperties: schema.additionalProperties,
  };
}

function itemsOf(node: unknown): unknown {
  return (node as { items?: unknown }).items;
}

describe('the JSON schema sent to the model', () => {
  const root = objectSchema(QUESTION_GRADING_JSON_SCHEMA);

  it('requires every key the Zod schema expects', () => {
    const zodKeys = Object.keys(ModelQuestionGradingSchema.shape).sort();
    expect(root.required.slice().sort()).toEqual(zodKeys);
    expect(Object.keys(root.properties).slice().sort()).toEqual(zodKeys);
  });

  it('leaves no optional keys anywhere, so nothing can be quietly omitted', () => {
    const check = (node: unknown, path: string) => {
      const schema = objectSchema(node);
      const propertyNames = Object.keys(schema.properties).sort();
      expect(schema.required.slice().sort(), `${path} required`).toEqual(propertyNames);
      expect(schema.additionalProperties, `${path} additionalProperties`).toBe(false);
    };

    check(QUESTION_GRADING_JSON_SCHEMA, 'root');
    check(itemsOf(root.properties.criteria), 'criteria[]');
    check(itemsOf(root.properties.findings), 'findings[]');

    const finding = objectSchema(itemsOf(root.properties.findings));
    check(finding.properties.region, 'findings[].region');
  });

  it('matches the criterion keys in the Zod schema', () => {
    const criteria = objectSchema(itemsOf(root.properties.criteria));
    const zodKeys = Object.keys(
      ModelQuestionGradingSchema.shape.criteria.element.shape,
    ).sort();

    expect(criteria.required.slice().sort()).toEqual(zodKeys);
  });

  it('matches the finding keys in the Zod schema', () => {
    const findings = objectSchema(itemsOf(root.properties.findings));
    const zodKeys = Object.keys(
      ModelQuestionGradingSchema.shape.findings.element.shape,
    ).sort();

    expect(findings.required.slice().sort()).toEqual(zodKeys);
  });

  it('uses the same enum values as the shared constants', () => {
    const criteria = objectSchema(itemsOf(root.properties.criteria));
    const status = criteria.properties.status as { enum: string[] };
    expect(status.enum).toEqual([...CRITERION_STATUSES]);

    const findings = objectSchema(itemsOf(root.properties.findings));
    const kind = findings.properties.kind as { enum: string[] };
    expect(kind.enum).toEqual([...FINDING_KINDS]);
  });
});

describe('parsing model output', () => {
  const valid = {
    questionId: 'q1',
    criteria: [
      {
        criterionId: 'q1c1',
        awardedMarks: 1,
        status: 'correct',
        evidenceQuote: 'a closed path',
        reasoning: 'Correctly described.',
        correction: null,
      },
    ],
    findings: [
      {
        criterionId: 'q1c1',
        kind: 'praise',
        quote: 'a closed path',
        region: null,
        comment: 'Good.',
        correction: null,
        severity: 'minor',
      },
    ],
    summary: 'Fine.',
    selfConfidence: 0.9,
  };

  it('accepts output that satisfies the contract', () => {
    const parsed = parseModelOutput(valid);
    expect(parsed.ok).toBe(true);
  });

  it('reports readable, path-prefixed errors for bad output', () => {
    const parsed = parseModelOutput({ ...valid, selfConfidence: 'very high', criteria: 'all fine' });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;

    // The repair prompt shows these to the model, so they have to be legible.
    expect(parsed.errors.join('\n')).toMatch(/criteria/);
    expect(parsed.errors.join('\n')).toMatch(/selfConfidence/);
  });

  it.each([null, undefined, 42, 'a string', [], {}])('rejects %s outright', (input) => {
    expect(parseModelOutput(input).ok).toBe(false);
  });

  it('rejects an unknown criterion status', () => {
    const parsed = parseModelOutput({
      ...valid,
      criteria: [{ ...valid.criteria[0], status: 'brilliant' }],
    });
    expect(parsed.ok).toBe(false);
  });
});
