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

/* ------------------------- chunk-level extraction ------------------------- */
/*
 * The schemas below read one *piece* of a document at a time, so a paper that
 * would not fit in a single request can still be read in full. Each entry says
 * whether it began before this piece or runs past its end, which is what lets
 * the merge step in `rubric/merge.ts` stitch a question that straddles a chunk
 * boundary back together by its number rather than by guessing.
 *
 * Same strict-mode discipline as above: every property required, no extras.
 */

const CONTINUATION_FLAGS = {
  continuesFromPreviousChunk: {
    type: 'boolean',
    description: 'True when this entry began before this excerpt, so the text here is only its later part.',
  },
  continuesIntoNextChunk: {
    type: 'boolean',
    description: 'True when this entry is cut off by the end of the excerpt and carries on afterwards.',
  },
} as const;

/** One excerpt of a question paper: the questions set, with their marks. */
export const QUESTION_PAPER_CHUNK_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      description: 'Every question, or part of one, whose text appears in this excerpt. Empty if none does.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'subject', 'prompt', 'maxMarks', 'requiresDiagram', ...Object.keys(CONTINUATION_FLAGS)],
        properties: {
          number: { type: 'integer', description: 'Question number as printed.' },
          subject: { type: 'string', description: 'Subject or topic, e.g. "Physics". Empty string if not stated.' },
          prompt: {
            type: 'string',
            description:
              'The question as set, copied as written, including every sub-part and any OR alternative. Not a summary.',
          },
          maxMarks: {
            type: ['number', 'null'],
            description: 'Marks printed against the question. Null when the excerpt does not say.',
          },
          requiresDiagram: {
            type: 'boolean',
            description: 'True when the question asks for a diagram, ray diagram, graph, circuit or labelled figure.',
          },
          ...CONTINUATION_FLAGS,
        },
      },
    },
  },
};

/** One excerpt of a marking scheme: value points and marks, per question. */
export const SCHEME_CHUNK_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      description: 'Every question, or part of one, whose marking appears in this excerpt. Empty if none does.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'number',
          'maxMarks',
          'modelAnswer',
          'guidance',
          'requiresDiagram',
          'criteria',
          ...Object.keys(CONTINUATION_FLAGS),
        ],
        properties: {
          number: { type: 'integer', description: 'Question number as printed.' },
          maxMarks: {
            type: ['number', 'null'],
            description: 'Total marks the scheme gives the question. Null when this excerpt does not state it.',
          },
          modelAnswer: {
            type: 'string',
            description: 'The worked answer or value points as the scheme writes them, copied not summarised.',
          },
          guidance: {
            type: 'array',
            description:
              'Examiner instructions, one per entry, verbatim — "award full marks for any other correct method", "any two reasons".',
            items: { type: 'string' },
          },
          requiresDiagram: {
            type: 'boolean',
            description: 'True when marks are awarded for a diagram, graph or figure.',
          },
          criteria: {
            type: 'array',
            description: 'The markable points in the order the scheme lists them, each with the marks it carries.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['description', 'maxMarks'],
              properties: {
                description: { type: 'string', description: 'The point, as the scheme words it.' },
                maxMarks: { type: 'number', description: 'Marks for this point, e.g. 0.5, 1, 2.' },
              },
            },
          },
          ...CONTINUATION_FLAGS,
        },
      },
    },
  },
};

/** One excerpt of a student's answer sheet: which questions it answers. */
export const ANSWER_CHUNK_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['answers'],
  properties: {
    answers: {
      type: 'array',
      description: 'One entry for each question the student is answering somewhere in this excerpt.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['questionNumber', 'beginsInThisChunk', 'firstWords'],
        properties: {
          questionNumber: { type: 'integer', description: 'The question being answered.' },
          beginsInThisChunk: {
            type: 'boolean',
            description: 'True when the answer to this question starts inside this excerpt rather than before it.',
          },
          firstWords: {
            type: ['string', 'null'],
            description:
              'When it begins here: the first six to ten words of the answer, copied exactly from the excerpt. Otherwise null.',
          },
        },
      },
    },
  },
};

/* ----------------------------- page transcription ----------------------------- */

/**
 * What a vision model returns for one scanned page of handwriting.
 *
 * The transcript is asked for exactly as written — misspellings, crossings-out
 * and all — because the grader must judge what the student wrote, not a tidied
 * version. Drawings cannot be transcribed, so each is described in words with
 * every label it carries, and its position in the text is kept with a marker.
 * Anything the model could not read is listed rather than guessed at, so that
 * uncertainty reaches the grader and the teacher instead of becoming a mark.
 */
const BOX_PROPERTIES = {
  top: { type: 'integer', description: 'Top edge, 0–1000 of the page height from the top.' },
  bottom: { type: 'integer', description: 'Bottom edge, 0–1000 of the page height from the top.' },
  left: { type: 'integer', description: 'Left edge, 0–1000 of the page width from the left.' },
  right: { type: 'integer', description: 'Right edge, 0–1000 of the page width from the left.' },
} as const;

export const PAGE_TRANSCRIPT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['lines', 'diagrams', 'unclear', 'struck', 'questionNumbers', 'legibility'],
  properties: {
    lines: {
      type: 'array',
      description:
        'Every written line on the page, in reading order, exactly as written, each with the box it occupies. Equations in plain text as the student wrote them. A line holding a drawing is "[diagram N]". Use [unclear: best guess] where a word cannot be read and [struck: text] for anything crossed out.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', ...Object.keys(BOX_PROPERTIES)],
        properties: {
          text: { type: 'string', description: 'The line, exactly as written.' },
          ...BOX_PROPERTIES,
        },
      },
    },
    diagrams: {
      type: 'array',
      description: 'One entry per [diagram N] line, with the box the drawing occupies.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['marker', 'description', 'labels', ...Object.keys(BOX_PROPERTIES)],
        properties: {
          marker: { type: 'integer', description: 'The N in the [diagram N] line.' },
          description: {
            type: 'string',
            description:
              'What the drawing shows and how its parts relate: shapes, arrows and their directions, axes, rays, components. Factual, not evaluative.',
          },
          labels: {
            type: 'array',
            description: 'Every label, symbol, value and annotation written on or beside the drawing, exactly as written.',
            items: { type: 'string' },
          },
          ...BOX_PROPERTIES,
        },
      },
    },
    unclear: {
      type: 'array',
      description: 'The best-guess text of every [unclear: …] marker, one per entry. Empty if everything was legible.',
      items: { type: 'string' },
    },
    struck: {
      type: 'array',
      description: 'Text the student crossed out, one entry per [struck: …] marker.',
      items: { type: 'string' },
    },
    questionNumbers: {
      type: 'array',
      description: 'Question numbers whose headings appear on this page ("Q31", "Ans 3", "31."). Empty if none.',
      items: { type: 'integer' },
    },
    legibility: {
      type: 'string',
      enum: ['good', 'fair', 'poor'],
      description: 'How readable the handwriting on this page was overall.',
    },
  },
};
