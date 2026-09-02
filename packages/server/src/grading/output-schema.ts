import { CRITERION_STATUSES, FINDING_KINDS } from '@gradesense/shared';

/**
 * JSON Schema handed to the Messages API as `output_config.format`.
 *
 * It mirrors `ModelQuestionGradingSchema` in the shared package, which is what
 * actually validates the response. Two representations of one contract is a
 * cost, but the alternative is worse: the SDK's Zod helper targets Zod v4 while
 * the shared schemas are v3, and more importantly the pipeline must be the thing
 * that decides whether output is acceptable. A provider that self-validated
 * would let a well-behaved mock hide misbehaviour in the real model.
 *
 * `schema-parity.test.ts` asserts the two stay in step.
 *
 * Structured outputs require `additionalProperties: false` and every property
 * listed in `required` — optional keys are what let a model quietly drop a
 * field, so there are none.
 */
export const QUESTION_GRADING_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['questionId', 'criteria', 'findings', 'summary', 'selfConfidence'],
  properties: {
    questionId: {
      type: 'string',
      description: 'The id of the question being marked, exactly as given.',
    },
    criteria: {
      type: 'array',
      description: 'One entry for every criterion id in the rubric, in the order given.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterionId', 'awardedMarks', 'status', 'evidenceQuote', 'reasoning', 'correction'],
        properties: {
          criterionId: { type: 'string', description: 'The criterion id, copied exactly.' },
          awardedMarks: {
            type: 'number',
            description: 'Marks earned for this criterion. Never above its maximum, never below zero.',
          },
          status: { type: 'string', enum: [...CRITERION_STATUSES] },
          evidenceQuote: {
            type: ['string', 'null'],
            description:
              'A verbatim span copied from the student answer, including any misspellings. Null only when the student never addressed this criterion.',
          },
          reasoning: {
            type: 'string',
            description: 'Why these marks were awarded, referring to what the student actually wrote.',
          },
          correction: {
            type: ['string', 'null'],
            description: 'What the student should have written. Null when the criterion is fully met.',
          },
        },
      },
    },
    findings: {
      type: 'array',
      description: 'Specific problems to draw on the answer paper.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterionId', 'kind', 'quote', 'region', 'comment', 'correction', 'severity'],
        properties: {
          criterionId: {
            type: ['string', 'null'],
            description: 'The criterion this finding explains, or null for a presentation-only note.',
          },
          kind: { type: 'string', enum: [...FINDING_KINDS] },
          quote: {
            type: ['string', 'null'],
            description: 'Exact student text this finding sits on. Strongly preferred over region.',
          },
          region: {
            type: ['object', 'null'],
            additionalProperties: false,
            required: ['page', 'x', 'y', 'width', 'height'],
            description:
              'Fallback anchor for things with no text to quote, such as a diagram. Fractions of the page; 0,0 is top-left.',
            properties: {
              page: { type: 'integer', description: 'Zero-based page index.' },
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
          },
          comment: { type: 'string', description: 'What is wrong, in one sentence a student can act on.' },
          correction: { type: ['string', 'null'], description: 'The corrected version.' },
          severity: { type: 'string', enum: ['minor', 'major'] },
        },
      },
    },
    summary: {
      type: 'string',
      description: 'Two or three sentences summarising the performance on this question.',
    },
    selfConfidence: {
      type: 'number',
      description: 'Genuine certainty about these marks, from 0 to 1.',
    },
  },
};

/**
 * JSON Schema for rubric extraction, used only when the structural parser in
 * `rubric/parse-scheme.ts` cannot read a marking scheme's layout.
 *
 * `id` and `title` are absent on purpose: those are ours to assign, and asking a
 * model to invent an identifier only creates something to reconcile later.
 */
export const RUBRIC_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      description: 'One entry per question in the marking scheme, in order.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'subject', 'prompt', 'modelAnswer', 'guidance', 'requiresDiagram', 'criteria'],
        properties: {
          number: { type: 'integer', description: 'Question number as printed.' },
          subject: { type: 'string', description: 'Subject or topic, e.g. "Science".' },
          prompt: { type: 'string', description: 'The question as set. Empty string if not supplied.' },
          modelAnswer: { type: 'string', description: 'The model answer prose, copied as written.' },
          guidance: {
            type: 'array',
            description: 'Grading guidance rules, one per entry, copied faithfully.',
            items: { type: 'string' },
          },
          requiresDiagram: {
            type: 'boolean',
            description: 'True when marks are awarded for a diagram, graph or chart.',
          },
          criteria: {
            type: 'array',
            description: 'The markable points, in the order the scheme lists them.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['description', 'maxMarks'],
              properties: {
                description: { type: 'string', description: 'The criterion, as the scheme words it.' },
                maxMarks: { type: 'number', description: 'Marks available for this criterion.' },
              },
            },
          },
        },
      },
    },
  },
};
