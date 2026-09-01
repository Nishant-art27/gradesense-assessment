import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Annotation, FindingKind, GradingResult, Rect } from '@gradesense/shared';

/**
 * Produces an annotated copy of the answer paper.
 *
 * The original bytes are loaded, copied into a new document, and never written
 * back. That is the brief's "the original answer paper must not be destroyed or
 * changed" rule, and it is enforced structurally rather than by convention:
 * this function takes a Buffer and returns a new one, and has no way to reach
 * the stored file. `export.test.ts` hashes the stored original before and after
 * to prove nothing moved.
 *
 * The export always reflects the annotations as they are *now*, so a teacher who
 * dragged a box, retyped a correction and deleted a spurious note gets exactly
 * what they see on screen.
 */

/** Colour per finding kind, chosen to stay legible over black text on white paper. */
const COLOURS: Record<FindingKind, { r: number; g: number; b: number }> = {
  incorrect: { r: 0.84, g: 0.15, b: 0.16 },
  missing: { r: 0.89, g: 0.47, b: 0.0 },
  spelling: { r: 0.17, g: 0.44, b: 0.78 },
  grammar: { r: 0.35, g: 0.35, b: 0.75 },
  layout: { r: 0.55, g: 0.35, b: 0.7 },
  praise: { r: 0.1, g: 0.55, b: 0.3 },
};

const LABELS: Record<FindingKind, string> = {
  incorrect: 'Incorrect',
  missing: 'Missing',
  spelling: 'Spelling',
  grammar: 'Grammar',
  layout: 'Layout',
  praise: 'Good',
};

export interface AnnotatedPdfInput {
  originalBytes: Buffer;
  result: GradingResult;
  annotations: Annotation[];
}

export async function buildAnnotatedPdf(input: AnnotatedPdfInput): Promise<Buffer> {
  const { originalBytes, result, annotations } = input;

  // `PDFDocument.load` parses a copy of the bytes; the caller's Buffer is not
  // modified, and the document we save is a distinct byte stream.
  const source = await PDFDocument.load(new Uint8Array(originalBytes));
  const output = await PDFDocument.create();

  const copied = await output.copyPages(source, source.getPageIndices());
  for (const page of copied) output.addPage(page);

  const font = await output.embedFont(StandardFonts.Helvetica);
  const boldFont = await output.embedFont(StandardFonts.HelveticaBold);

  const pages = output.getPages();

  // Number the annotations per page so the marks on the paper line up with the
  // list on the summary sheet.
  const numbering = new Map<string, number>();
  annotations.forEach((annotation, index) => numbering.set(annotation.id, index + 1));

  for (const annotation of annotations) {
    const page = pages[annotation.rect.page];
    if (!page) continue;
    drawAnnotation(page, annotation, font, boldFont, numbering.get(annotation.id) ?? 0);
  }

  addSummaryPage(output, result, annotations, font, boldFont, numbering);

  const bytes = await output.save();
  return Buffer.from(bytes);
}

/** Converts a normalised rect into pdf-lib's bottom-left origin coordinates. */
function toPdfRect(page: PDFPage, rect: Rect): { x: number; y: number; width: number; height: number } {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  return {
    x: rect.x * pageWidth,
    y: pageHeight - (rect.y + rect.height) * pageHeight,
    width: rect.width * pageWidth,
    height: rect.height * pageHeight,
  };
}

function drawAnnotation(
  page: PDFPage,
  annotation: Annotation,
  font: PDFFont,
  boldFont: PDFFont,
  index: number,
): void {
  const colour = COLOURS[annotation.kind];
  const stroke = rgb(colour.r, colour.g, colour.b);
  const rects = [annotation.rect, ...annotation.extraRects];

  for (const rect of rects) {
    const box = toPdfRect(page, rect);

    if (annotation.kind === 'praise') {
      // Praise is underlined rather than boxed — a box reads as a correction.
      page.drawLine({
        start: { x: box.x, y: box.y - 1 },
        end: { x: box.x + box.width, y: box.y - 1 },
        thickness: 1.1,
        color: stroke,
        opacity: 0.85,
      });
      continue;
    }

    page.drawRectangle({
      x: box.x - 1.5,
      y: box.y - 2,
      width: box.width + 3,
      height: box.height + 3,
      borderColor: stroke,
      borderWidth: 1,
      // A faint wash keeps the box visible without hiding the student's writing.
      color: stroke,
      opacity: 0.05,
      borderOpacity: 0.9,
    });
  }

  /*
   * Only a numbered marker goes on the page — the comment and the correction
   * live on the summary sheet.
   *
   * An earlier version wrote the correction beside each box. On a densely marked
   * paper that produced overlapping red text across the student's own writing
   * and made both unreadable. Numbering the marks and keying them to a list is
   * how a teacher actually annotates a script, and it keeps the paper legible
   * however many findings there are.
   */
  const anchorBox = toPdfRect(page, annotation.rect);
  const { width: pageWidth } = page.getSize();

  const marker = `${index}`;
  const markerWidth = boldFont.widthOfTextAtSize(marker, 7) + 6;
  const markerX = Math.min(anchorBox.x + anchorBox.width + 3, pageWidth - markerWidth - 4);
  const markerY = anchorBox.y + anchorBox.height - 2;

  page.drawRectangle({
    x: markerX,
    y: markerY,
    width: markerWidth,
    height: 9,
    color: stroke,
    opacity: 0.92,
  });
  page.drawText(marker, {
    x: markerX + 3,
    y: markerY + 2,
    size: 7,
    font: boldFont,
    color: rgb(1, 1, 1),
  });

  /*
   * A margin note has no student text under it — it exists because the mistake
   * is something the student never wrote, so there is nothing to underline.
   * Without a word inside it, the box is just an unexplained rectangle, so the
   * finding's type goes in it. Boxes that sit on actual text need no label:
   * what they frame is the explanation.
   */
  if (annotation.anchorStatus === 'unresolved') {
    const label = LABELS[annotation.kind];
    const size = 7.5;
    page.drawText(label, {
      x: anchorBox.x + 5,
      y: anchorBox.y + anchorBox.height / 2 - size / 2 + 1,
      size,
      font: boldFont,
      color: stroke,
      opacity: 0.95,
    });
    page.drawText('see summary', {
      x: anchorBox.x + 5,
      y: anchorBox.y + anchorBox.height / 2 - size / 2 - 8,
      size: 6,
      font,
      color: stroke,
      opacity: 0.7,
    });
  }
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const sanitised = sanitise(text);
  const words = sanitised.split(/\s+/);
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line.length > 0) lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);

  return lines;
}

/**
 * The standard PDF fonts are WinAnsi-encoded and throw on characters outside it.
 * Feedback text is free-form and may well contain a curly quote or a rupee sign,
 * so it is folded to the closest ASCII rather than allowed to fail the export.
 */
function sanitise(text: string): string {
  return text
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/₹/g, 'Rs ')
    .replace(/[^\x20-\x7E]/g, '');
}

/**
 * A final page listing every annotation and the marks.
 *
 * Boxes on a page can only carry so much text. This is where a teacher (or the
 * student) can read the full comment behind each numbered mark, see the rubric
 * breakdown, and — when the system was unsure — read why it asked for review.
 */
function addSummaryPage(
  output: PDFDocument,
  result: GradingResult,
  annotations: Annotation[],
  font: PDFFont,
  boldFont: PDFFont,
  numbering: Map<string, number>,
): void {
  const margin = 48;
  let page = output.addPage();
  let { width, height } = page.getSize();
  let y = height - margin;

  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.42, 0.42, 0.46);

  const newPageIfNeeded = (needed: number) => {
    if (y - needed < margin) {
      page = output.addPage();
      ({ width, height } = page.getSize());
      y = height - margin;
    }
  };

  const write = (text: string, size: number, usedFont: PDFFont, colour = ink, indent = 0) => {
    for (const line of wrapText(text, usedFont, size, width - margin * 2 - indent)) {
      newPageIfNeeded(size + 4);
      page.drawText(line, { x: margin + indent, y, size, font: usedFont, color: colour });
      y -= size + 3.5;
    }
  };

  write('Marking summary', 17, boldFont);
  y -= 6;
  write(
    `${result.totalMarks} out of ${result.maxMarks} marks  ·  confidence ${(result.confidence * 100).toFixed(0)}%  ·  marked by ${result.provider}/${result.model}`,
    9.5,
    font,
    muted,
  );
  y -= 8;

  if (result.requiresHumanReview) {
    write('This paper needs a human check before the marks are used:', 10, boldFont, rgb(0.75, 0.35, 0.0));
    for (const reason of result.reviewReasons) {
      write(`•  ${reason}`, 9, font, muted, 8);
    }
    y -= 8;
  }

  for (const question of result.questions) {
    newPageIfNeeded(60);
    y -= 6;
    const state = question.state === 'graded' ? '' : `   [${question.state}]`;
    write(
      `Question ${question.number} — ${question.subject}:  ${question.awardedMarks} / ${question.maxMarks}${state}`,
      12,
      boldFont,
    );
    write(question.summary, 9, font, muted);
    y -= 3;

    for (const criterion of question.criteria) {
      const mark = `${criterion.awardedMarks}/${criterion.maxMarks}`;
      write(`${mark}   ${criterion.description}`, 8.5, boldFont, ink, 8);
      write(criterion.reasoning, 8, font, muted, 22);
      if (criterion.evidence) {
        const verified = criterion.evidence.verified ? '' : '  (quote not found in the answer — unverified)';
        write(`Evidence: "${truncate(criterion.evidence.quote, 150)}"${verified}`, 7.5, font, muted, 22);
      }
      if (criterion.correction) {
        write(`Correction: ${criterion.correction}`, 7.5, font, muted, 22);
      }
      y -= 2;
    }
  }

  if (annotations.length > 0) {
    newPageIfNeeded(40);
    y -= 10;
    write('Annotations on the paper', 12, boldFont);
    y -= 2;

    for (const annotation of annotations) {
      const number = numbering.get(annotation.id) ?? 0;
      const edited = annotation.editedByHuman ? '  (edited by teacher)' : '';
      const placement = annotation.anchorStatus === 'unresolved' ? '  (margin note — could not be placed)' : '';
      newPageIfNeeded(24);
      write(
        `${number}.  [${LABELS[annotation.kind]}] page ${annotation.rect.page + 1}${placement}${edited}`,
        8.5,
        boldFont,
        ink,
        8,
      );
      write(annotation.comment, 8, font, muted, 22);
      if (annotation.correction) write(`→ ${annotation.correction}`, 8, font, muted, 22);
      y -= 2;
    }
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}
