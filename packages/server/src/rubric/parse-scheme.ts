import type { Criterion, DraftQuestion, DraftRubric } from '@gradesense/shared';

/**
 * Reading a rubric out of an uploaded marking scheme.
 *
 * Marking schemes are written for humans but they are highly structured: a
 * question heading, a model answer, a table of criteria with marks, and a block
 * of grading guidance. That structure is enough to extract a rubric
 * deterministically — no model call, no API key, and the same answer every time.
 *
 * This runs first for every upload. The language model is the *fallback* for a
 * scheme whose layout this cannot read, which is the opposite of the usual
 * arrangement and deliberately so: when a document can be parsed exactly, doing
 * it exactly is better than asking a model to read it.
 *
 * The output is always a draft. A rubric is the specification every mark is
 * measured against, so a human confirms it before any script is marked.
 */

export interface ParseWarning {
  message: string;
}

export interface ParsedScheme {
  /**
   * Criteria may be empty on a question whose scheme had no rubric table. That
   * is deliberate: `extractRubric` fills those in and only then validates
   * against the strict `RubricSchema`.
   */
  rubric: DraftRubric | null;
  warnings: string[];
}

/* --------------------------- question paper ---------------------------- */

interface ParsedPrompt {
  number: number;
  subject: string;
  maxMarks: number | null;
  prompt: string;
}

/** `Question 1 — Science` followed by `5 Marks` and the question text. */
const QUESTION_HEADING = /^\s*Question\s+(\d+)\s*[—–\-:]\s*(.+?)\s*$/i;
const MARKS_LINE = /^\s*(\d+(?:\.\d+)?)\s*Marks?\s*$/i;
const EXPECTED_ANSWER = /^\s*Expected answer\s*:/i;

export function parseQuestionPaper(text: string): Map<number, ParsedPrompt> {
  const found = new Map<number, ParsedPrompt>();
  const lines = text.split('\n');

  let current: ParsedPrompt | null = null;
  const body: string[] = [];

  const flush = () => {
    if (!current) return;
    found.set(current.number, { ...current, prompt: body.join(' ').replace(/\s+/g, ' ').trim() });
    body.length = 0;
  };

  for (const raw of lines) {
    const heading = QUESTION_HEADING.exec(raw);
    if (heading) {
      flush();
      current = {
        number: Number(heading[1]),
        subject: (heading[2] ?? '').trim(),
        maxMarks: null,
        prompt: '',
      };
      continue;
    }
    if (!current) continue;

    const marks = MARKS_LINE.exec(raw);
    if (marks) {
      current.maxMarks = Number(marks[1]);
      continue;
    }

    // "Expected answer: ..." is guidance to the candidate, not part of the task.
    if (EXPECTED_ANSWER.test(raw)) continue;

    if (raw.trim().length > 0) body.push(raw.trim());
  }

  flush();
  return found;
}

/* --------------------------- marking scheme ---------------------------- */

/** `Q1 — Science`, the heading style marking schemes use. */
const SCHEME_HEADING = /^\s*Q(?:uestion)?\s*(\d+)\s*[—–\-:]\s*(.+?)\s*$/i;
const MODEL_ANSWER_HEADING = /^\s*Model Answer\s*[—–\-:]?\s*(\d+(?:\.\d+)?)?\s*marks?\s*$/i;
const RUBRIC_HEADING = /^\s*Marking\s+rubric\s*$/i;
const RUBRIC_TABLE_HEAD = /^\s*Criterion\s+Marks\s*$/i;
const TOTAL_LINE = /^\s*Total\s+(\d+(?:\.\d+)?)\s*$/i;
const GUIDANCE_HEADING = /^\s*Important\s+grading\s+guidance\s*$/i;
/** A criterion line ends with its mark; the mark may also sit on its own line. */
const TRAILING_MARK = /^(.*?)\s*(\d+(?:\.\d+)?)\s*$/;

interface ParsedSchemeQuestion {
  number: number;
  subject: string;
  declaredTotal: number | null;
  modelAnswer: string;
  criteria: Array<{ description: string; maxMarks: number }>;
  guidance: string[];
}

type Section = 'answer' | 'rubric' | 'guidance';

export function parseMarkingScheme(text: string): ParsedSchemeQuestion[] {
  const questions: ParsedSchemeQuestion[] = [];
  const lines = text.split('\n');

  let current: ParsedSchemeQuestion | null = null;
  let section: Section = 'answer';
  let answerLines: string[] = [];
  /** Holds a criterion whose text wrapped before its mark appeared. */
  let pending: string[] = [];

  const flush = () => {
    if (!current) return;
    current.modelAnswer = answerLines.join(' ').replace(/\s+/g, ' ').trim();
    questions.push(current);
    answerLines = [];
    pending = [];
  };

  for (const raw of lines) {
    const line = raw.trim();

    const heading = SCHEME_HEADING.exec(line);
    if (heading) {
      flush();
      current = {
        number: Number(heading[1]),
        subject: (heading[2] ?? '').trim(),
        declaredTotal: null,
        modelAnswer: '',
        criteria: [],
        guidance: [],
      };
      section = 'answer';
      continue;
    }

    if (!current) continue;

    if (RUBRIC_HEADING.test(line)) {
      section = 'rubric';
      pending = [];
      continue;
    }
    if (GUIDANCE_HEADING.test(line)) {
      section = 'guidance';
      pending = [];
      continue;
    }

    if (section === 'answer') {
      const modelHeading = MODEL_ANSWER_HEADING.exec(line);
      if (modelHeading) {
        if (modelHeading[1]) current.declaredTotal = Number(modelHeading[1]);
        continue;
      }
      // Bullet markers carry no meaning once the text is flattened.
      if (line.length > 0) answerLines.push(line.replace(/^[•·▪\-*]\s*/, ''));
      continue;
    }

    if (section === 'rubric') {
      if (line.length === 0 || RUBRIC_TABLE_HEAD.test(line)) continue;

      const total = TOTAL_LINE.exec(line);
      if (total) {
        current.declaredTotal = Number(total[1]);
        pending = [];
        continue;
      }

      const withMark = TRAILING_MARK.exec(line);
      const marks = withMark ? Number(withMark[2]) : Number.NaN;

      // A trailing number is only a mark if it is a plausible one. Criteria
      // routinely end in figures — "the equilibrium at Rs 30 and 60 units" — so
      // an implausible value means the line is still criterion text.
      if (withMark && Number.isFinite(marks) && marks > 0 && marks <= 20) {
        const description = [...pending, (withMark[1] ?? '').trim()]
          .filter((part) => part.length > 0)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        pending = [];
        if (description.length > 0) current.criteria.push({ description, maxMarks: marks });
        continue;
      }

      pending.push(line);
      continue;
    }

    if (line.length > 0) current.guidance.push(line);
  }

  flush();

  // Guidance arrives as wrapped lines; rejoin them into sentences.
  for (const question of questions) {
    question.guidance = rejoinSentences(question.guidance);
  }

  return questions;
}

/**
 * Wrapped lines are joined back into sentences, because a guidance rule split
 * across two lines reads as two broken instructions in a prompt.
 */
function rejoinSentences(lines: string[]): string[] {
  const joined = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (joined.length === 0) return [];

  return joined
    .split(/(?<=[.!?])\s+(?=[A-Z"“])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 12);
}

/* ------------------------------ assembly ------------------------------- */

const DIAGRAM_WORDS = /\b(diagram|graph|chart|plot|sketch|draw|drawn|axes|curve)\b/i;

/**
 * Combines a parsed marking scheme with the question paper into a rubric.
 *
 * The scheme supplies the criteria, marks, model answer and guidance. The
 * question paper supplies the prompt as it was actually set — a marking scheme
 * usually restates the question loosely or not at all, and the grader should see
 * what the candidate saw.
 */
export function buildRubric(
  schemeText: string,
  questionPaperText: string | null,
  options: { id: string; title: string },
): ParsedScheme {
  const warnings: string[] = [];
  const scheme = parseMarkingScheme(schemeText);

  if (scheme.length === 0) {
    return {
      rubric: null,
      warnings: ['No question headings (for example "Q1 — Science") were found in the marking scheme.'],
    };
  }

  const prompts = questionPaperText ? parseQuestionPaper(questionPaperText) : new Map<number, ParsedPrompt>();
  if (questionPaperText && prompts.size === 0) {
    warnings.push('No questions could be read from the question paper, so the prompts are taken from the marking scheme.');
  }

  const questions: DraftQuestion[] = [];

  for (const parsed of scheme) {
    const prompt = prompts.get(parsed.number);

    /*
     * A question with no rubric table used to be dropped from the paper here,
     * which silently shrank the total and lost the question altogether. It is
     * now kept with no criteria and marked for inference — the absence of a
     * rubric for one question must never stop the rest being graded.
     */
    const criteria: Criterion[] = parsed.criteria.map((criterion, index) => ({
      id: `q${parsed.number}c${index + 1}`,
      description: criterion.description,
      maxMarks: criterion.maxMarks,
    }));

    const criteriaSum = criteria.reduce((total, criterion) => total + criterion.maxMarks, 0);
    const declared = parsed.declaredTotal ?? prompt?.maxMarks ?? criteriaSum;

    if (criteria.length === 0) {
      // The stated total is what inference has to add up to, so it matters that
      // the scheme or the paper gave us one.
      warnings.push(
        declared > 0
          ? `Question ${parsed.number}: the scheme defines no marking criteria. Criteria will be inferred from the model answer, to total ${declared} marks.`
          : `Question ${parsed.number}: the scheme defines no marking criteria and states no total, so its marks cannot be determined.`,
      );
    }

    // The criteria are the source of truth for the question's value: they are
    // what marks are actually awarded against. A stated total that disagrees is
    // reported rather than silently preferred.
    if (criteria.length > 0 && Math.abs(declared - criteriaSum) > 1e-9) {
      warnings.push(
        `Question ${parsed.number}: the scheme states ${declared} marks but its criteria add up to ${criteriaSum}. Using ${criteriaSum}.`,
      );
    }

    const promptText = prompt?.prompt ?? '';
    if (promptText.length === 0) {
      warnings.push(`Question ${parsed.number}: no question text was found, so the grader sees only the model answer.`);
    }

    // Reported separately from missing criteria: a question can have the
    // instructor's markable points but none of their grading rules, and that is
    // a smaller thing than having no rubric at all.
    if (criteria.length > 0 && parsed.guidance.length === 0) {
      warnings.push(
        `Question ${parsed.number}: the scheme gives no grading guidance, so the grader applies the criteria without further instruction.`,
      );
    }

    questions.push({
      id: `q${parsed.number}`,
      number: parsed.number,
      subject: parsed.subject || prompt?.subject || 'General',
      maxMarks: criteria.length > 0 ? criteriaSum : declared,
      prompt: promptText,
      criteriaSource: 'instructor',
      modelAnswer: parsed.modelAnswer,
      guidance: parsed.guidance,
      requiresDiagram: DIAGRAM_WORDS.test(`${promptText} ${parsed.modelAnswer}`),
      criteria,
    });
  }

  if (questions.length === 0) {
    return { rubric: null, warnings: [...warnings, 'No usable questions were found in the marking scheme.'] };
  }

  questions.sort((a, b) => a.number - b.number);

  return {
    rubric: {
      id: options.id,
      title: options.title,
      totalMarks: questions.reduce((total, question) => total + question.maxMarks, 0),
      questions,
    },
    warnings,
  };
}
