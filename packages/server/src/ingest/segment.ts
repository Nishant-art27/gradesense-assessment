import type { PageText, Question } from '@gradesense/shared';

/**
 * Splitting one answer sheet into per-question answers.
 *
 * Grading question by question rather than in one shot is worth the extra model
 * calls: the prompt stays focused on a single rubric, a failure on one question
 * cannot corrupt the other two, and a per-question blank check can skip the
 * model entirely.
 *
 * The answer sheets carry "Answer 1", "Answer 2", "Answer 3" headings, so the
 * split is a search for those markers. When an uploaded sheet has no markers we
 * say so and hand the whole document to every question rather than guessing at
 * boundaries — the caller records that as a note on the result.
 */

export interface AnswerSegment {
  questionId: string;
  number: number;
  text: string;
  /** Page the answer starts on. Used only to bias annotation search. */
  startPage: number;
  /** True when segmentation fell back to using the whole document. */
  approximate: boolean;
}

const ANSWER_MARKER = /(?:^|\n)[ \t]*(?:Answer|Ans\.?|Q(?:uestion)?)[ \t]*(\d+)/gi;

interface Marker {
  number: number;
  /** Offset into the joined document text. */
  offset: number;
  /** Offset just past the heading, where the answer body begins. */
  bodyOffset: number;
}

interface JoinedText {
  text: string;
  /** `pageStarts[i]` is the offset in `text` where page `i` begins. */
  pageStarts: number[];
}

function joinPages(pages: PageText[]): JoinedText {
  const parts: string[] = [];
  const pageStarts: number[] = [];
  let offset = 0;

  for (const page of pages) {
    pageStarts.push(offset);
    parts.push(page.text);
    offset += page.text.length + 1; // the '\n' inserted between pages
  }

  return { text: parts.join('\n'), pageStarts };
}

function pageForOffset(offset: number, pageStarts: number[]): number {
  let page = 0;
  for (let i = 0; i < pageStarts.length; i += 1) {
    if (offset >= pageStarts[i]!) page = i;
    else break;
  }
  return page;
}

function findMarkers(text: string): Marker[] {
  const markers: Marker[] = [];
  ANSWER_MARKER.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = ANSWER_MARKER.exec(text)) !== null) {
    const number = Number(match[1]);
    if (!Number.isFinite(number)) continue;
    // Keep only the first heading seen for each number: a later reference such
    // as "see Answer 1 above" must not restart the segment.
    if (markers.some((marker) => marker.number === number)) continue;
    markers.push({
      number,
      offset: match.index,
      bodyOffset: match.index + match[0].length,
    });
  }

  return markers.sort((a, b) => a.offset - b.offset);
}

/**
 * Strips the remainder of the heading line (" - Science") so the segment text
 * starts at the student's actual prose.
 */
function trimHeadingRemainder(body: string): string {
  const newline = body.indexOf('\n');
  if (newline === -1) return body.trim();
  const firstLine = body.slice(0, newline);
  // A heading remainder is short and has no sentence in it.
  return (/^[\s\-–—:.()a-zA-Z]{0,40}$/.test(firstLine) ? body.slice(newline + 1) : body).trim();
}

export function segmentAnswers(pages: PageText[], questions: Question[]): AnswerSegment[] {
  const joined = joinPages(pages);
  const markers = findMarkers(joined.text);

  if (markers.length === 0) {
    return questions.map((question) => ({
      questionId: question.id,
      number: question.number,
      text: joined.text.trim(),
      startPage: 0,
      approximate: true,
    }));
  }

  return questions.map((question) => {
    const markerIndex = markers.findIndex((marker) => marker.number === question.number);
    if (markerIndex === -1) {
      // The sheet has markers but not this one — the student skipped the
      // question entirely, so there is genuinely nothing to grade.
      return {
        questionId: question.id,
        number: question.number,
        text: '',
        startPage: 0,
        approximate: true,
      };
    }

    const marker = markers[markerIndex]!;
    const next = markers[markerIndex + 1];
    const body = joined.text.slice(marker.bodyOffset, next ? next.offset : undefined);

    return {
      questionId: question.id,
      number: question.number,
      text: trimHeadingRemainder(body),
      startPage: pageForOffset(marker.offset, joined.pageStarts),
      approximate: false,
    };
  });
}

/**
 * Whether a segment should be treated as unanswered.
 *
 * Deliberately conservative and text-only — we do not try to detect whether a
 * diagram was drawn. A question flagged blank always forces a human-review flag
 * on the result, so a diagram-only answer is escalated rather than silently
 * marked zero.
 */
export function isBlankAnswer(segment: AnswerSegment, minChars: number): boolean {
  const meaningful = segment.text.replace(/[^\p{L}\p{N}]/gu, '');
  return meaningful.length < minChars;
}
