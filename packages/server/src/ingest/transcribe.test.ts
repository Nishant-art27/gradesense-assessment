import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { IngestedDocument } from '@gradesense/shared';
import type { GradingModel, ModelResponse, PageTranscriptionInput } from '../grading/model.js';
import { extractPdf } from './pdf.js';
import { canRenderPages } from './render.js';
import {
  buildPageText,
  composePageText,
  needsTranscription,
  normaliseBox,
  pagesNeedingTranscription,
  transcribeDocument,
} from './transcribe.js';

const box = { top: 100, bottom: 200, left: 100, right: 900 };
const line = (text: string) => ({ text, ...box });

/**
 * The transcriber is a model; the tests fake it. What is under test is the
 * plumbing that decides which pages need reading, hands them over one at a
 * time with the previous page's tail, folds the reply back into the document
 * exactly (diagrams in place, markers kept), and says honestly when the
 * provider cannot read images at all.
 */

async function scannedLikePdf(): Promise<{ document: IngestedDocument; bytes: Buffer }> {
  // Page 1 has a text layer; pages 2 and 3 are "scans": nothing but a drawing.
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([595, 842]).drawText('Q31 typed answer text that is long enough to count as a text layer.', { x: 40, y: 800, size: 12, font });
  pdf.addPage([595, 842]).drawLine({ start: { x: 50, y: 50 }, end: { x: 500, y: 700 } });
  pdf.addPage([595, 842]).drawLine({ start: { x: 50, y: 700 }, end: { x: 500, y: 50 } });
  const bytes = Buffer.from(await pdf.save());
  const extracted = await extractPdf(bytes);
  const document: IngestedDocument = {
    id: 'doc-1',
    kind: 'student_answer',
    filename: 'scan.pdf',
    byteLength: bytes.length,
    sha256: extracted.sha256,
    pageCount: extracted.pageCount,
    pages: extracted.pages,
    fullText: extracted.fullText,
    createdAt: new Date().toISOString(),
  };
  return { document, bytes };
}

class FakeVisionModel implements GradingModel {
  readonly providerName = 'fake';
  readonly modelName = 'fake-grader';
  readonly visionModelName = 'fake-vision';
  readonly calls: PageTranscriptionInput[] = [];

  async gradeQuestion(): Promise<ModelResponse> {
    throw new Error('not used');
  }

  async transcribePage(input: PageTranscriptionInput): Promise<ModelResponse> {
    this.calls.push(input);
    const data = {
      lines: [
        { text: `Q3${input.pageIndex}. (a)`, top: 50, bottom: 80, left: 100, right: 300 },
        { text: 'The feild is [unclear: uniform] here.', top: 100, bottom: 130, left: 100, right: 800 },
        { text: '[diagram 1]', top: 150, bottom: 400, left: 200, right: 700 },
        { text: '[struck: wrong start]', top: 420, bottom: 450, left: 100, right: 500 },
        { text: 'E = 2qi N/C', top: 470, bottom: 500, left: 100, right: 400 },
      ],
      diagrams: [{ marker: 1, description: 'A rod pivoted at O rotating in a field into the page.', labels: ['O', 'l = 50 cm', 'B into the page (4.0 mT)'], top: 150, bottom: 400, left: 200, right: 700 }],
      unclear: ['uniform'],
      struck: ['wrong start'],
      questionNumbers: [30 + input.pageIndex],
      legibility: input.pageIndex === 2 ? 'fair' : 'good',
    };
    return { data, raw: JSON.stringify(data) };
  }
}

const textOnly: GradingModel = {
  providerName: 'mock',
  modelName: 'rule-based-mock',
  async gradeQuestion() {
    throw new Error('not used');
  },
};

describe('pagesNeedingTranscription', () => {
  it('picks out the pages with no usable text layer', async () => {
    const { document } = await scannedLikePdf();
    expect(pagesNeedingTranscription(document)).toEqual([1, 2]);
    expect(needsTranscription(document)).toBe(true);
  });

  it('leaves a typed document alone', async () => {
    const { document } = await scannedLikePdf();
    const typed = { ...document, pages: document.pages.slice(0, 1), pageCount: 1 };
    expect(pagesNeedingTranscription(typed)).toEqual([]);
    expect(needsTranscription(typed)).toBe(false);
  });
});

describe('composePageText', () => {
  it('expands diagram markers in place with their labels and keeps the other markers', () => {
    const text = composePageText({
      lines: [line('Before'), line('[diagram 1]'), line('After [unclear: this] and [struck: that]')],
      diagrams: [{ marker: 1, description: 'A solenoid.', labels: ['area A', 'N turns'], ...box }],
      unclear: ['this'],
      struck: ['that'],
      questionNumbers: [],
      legibility: 'good',
    });
    expect(text).toBe('Before\n[Diagram 1: A solenoid. Labels: area A | N turns.]\nAfter [unclear: this] and [struck: that]');
  });

  it('appends a diagram whose marker the model forgot to place', () => {
    const text = composePageText({
      lines: [line('Only prose')],
      diagrams: [{ marker: 2, description: 'A graph.', labels: [], ...box }],
      unclear: [],
      struck: [],
      questionNumbers: [],
      legibility: 'good',
    });
    expect(text).toBe('Only prose\n[Diagram 2: A graph.]');
  });
});

describe('transcribeDocument', () => {
  it('reads only the scanned pages, in order, and folds the transcript into the document', async () => {
    if (!(await canRenderPages())) return;
    const { document, bytes } = await scannedLikePdf();
    const model = new FakeVisionModel();

    const result = await transcribeDocument({ document, bytes, model, maxAttempts: 2, retryBaseDelayMs: 1 });

    expect(model.calls.map((call) => call.pageIndex)).toEqual([1, 2]);
    expect(model.calls[0]!.previousPageTail).toBeNull();
    expect(model.calls[1]!.previousPageTail).toContain('E = 2qi N/C');
    expect(model.calls[0]!.mimeType).toBe('image/jpeg');
    expect(model.calls[0]!.imageBase64.length).toBeGreaterThan(1_000);

    // The typed page is untouched; the scanned pages carry the transcript.
    expect(result.pages[0]!.text).toContain('typed answer text');
    expect(result.pages[0]!.source).toBeUndefined();
    expect(result.pages[1]!.source).toBe('transcription');
    // One run per positioned line, so quotes can be placed beside their line.
    expect(result.pages[1]!.runs).toHaveLength(5);
    expect(result.pages[1]!.runs[0]).toMatchObject({ text: 'Q31. (a)', start: 0, rect: { page: 1, y: 0.05 } });
    expect(result.pages[1]!.text).toContain('[Diagram 1: A rod pivoted at O');
    expect(result.pages[1]!.text).toContain('[unclear: uniform]');
    expect(result.pages[1]!.text).toContain('[struck: wrong start]');
    expect(result.fullText).toContain('Q32. (a)');

    expect(result.transcription).toMatchObject({
      status: 'done',
      pages: [1, 2],
      provider: 'fake',
      model: 'fake-vision',
      legibility: 'fair',
      unclear: ['uniform', 'uniform'],
      error: null,
    });
    expect(needsTranscription(result)).toBe(false);
  });

  it('marks the document unsupported, rather than blank, when the provider cannot see', async () => {
    const { document, bytes } = await scannedLikePdf();

    const result = await transcribeDocument({ document, bytes, model: textOnly, maxAttempts: 1, retryBaseDelayMs: 1 });

    expect(result.transcription?.status).toBe('unsupported');
    expect(result.transcription?.pages).toEqual([1, 2]);
    expect(result.transcription?.error).toMatch(/cannot read images/);
    expect(result.pages[1]!.text).toBe(document.pages[1]!.text);
  });

  it('returns a typed document unchanged without calling the model', async () => {
    const { document, bytes } = await scannedLikePdf();
    const typed = { ...document, pages: document.pages.slice(0, 1), pageCount: 1 };
    const model = new FakeVisionModel();

    const result = await transcribeDocument({ document: typed, bytes, model, maxAttempts: 1, retryBaseDelayMs: 1 });

    expect(result).toBe(typed);
    expect(model.calls).toEqual([]);
  });
});

describe('normaliseHeadings', () => {
  it('restores a question heading whose Q was read as another glyph', async () => {
    const { normaliseHeadings } = await import('./transcribe.js');
    expect(normaliseHeadings("g32 (a) Lens maker's formula\nso 1/f = ...", [32])).toBe("Q32 (a) Lens maker's formula\nso 1/f = ...");
    expect(normaliseHeadings('O 33 (a)\ntext', [33])).toBe('Q33 (a)\ntext');
    expect(normaliseHeadings('q.31 (a)', [31])).toBe('Q31 (a)');
  });

  it('leaves everything else alone', async () => {
    const { normaliseHeadings } = await import('./transcribe.js');
    expect(normaliseHeadings('Q31. (a)\ng = 9.8 m/s^2\ng32 is not expected here', [31])).toBe('Q31. (a)\ng = 9.8 m/s^2\ng32 is not expected here');
    expect(normaliseHeadings('g32 (a)', [])).toBe('Q32 (a)');
    expect(normaliseHeadings('omega32 = 5', [32])).toBe('omega32 = 5');
  });
});

describe('undescribed diagram markers', () => {
  it('finds markers the transcriber placed but did not describe', async () => {
    const { undescribedDiagramMarkers } = await import('./transcribe.js');
    expect(
      undescribedDiagramMarkers({
        lines: [line('a'), line('[diagram 1]'), line('b'), line('[diagram 2]')],
        diagrams: [{ marker: 2, description: 'x', labels: [], ...box }],
        unclear: [],
        struck: [],
        questionNumbers: [],
        legibility: 'good',
      }),
    ).toEqual([1]);
  });

  it('keeps an undescribed marker in the text and says the drawing could not be described', () => {
    const text = composePageText({
      lines: [line('Q31 (a)'), line('[diagram 1]'), line('The dipole...')],
      diagrams: [],
      unclear: [],
      struck: [],
      questionNumbers: [31],
      legibility: 'good',
    });
    expect(text).toContain('[Diagram 1: a drawing is present here but could not be described');
  });
});

describe('transcribeDocument diagram repair', () => {
  it('re-asks once for diagrams when a page marked one without describing it', async () => {
    if (!(await canRenderPages())) return;
    const { document, bytes } = await scannedLikePdf();

    const calls: PageTranscriptionInput[] = [];
    const model: GradingModel & { transcribePage: (input: PageTranscriptionInput) => Promise<ModelResponse> } = {
      providerName: 'fake',
      modelName: 'fake',
      async gradeQuestion() {
        throw new Error('not used');
      },
      async transcribePage(input) {
        calls.push(input);
        const data =
          input.focus === 'diagrams'
            ? { lines: [line('[diagram 1]')], diagrams: [{ marker: 1, description: 'Three lenses on an axis.', labels: ['L1', 'L2', 'L3', '80 cm'], ...box }], unclear: [], struck: [], questionNumbers: [], legibility: 'good' }
            : { lines: [line('g32 (b)'), line('[diagram 1]'), line('f1 = 40 cm')], diagrams: [], unclear: [], struck: [], questionNumbers: [32], legibility: 'good' };
        return { data, raw: JSON.stringify(data) };
      },
    };

    const result = await transcribeDocument({ document, bytes, model, maxAttempts: 1, retryBaseDelayMs: 1 });

    // Two scanned pages, each read once and re-asked once for its diagram.
    expect(calls.map((call) => `${call.pageIndex}:${call.focus ?? 'full'}`)).toEqual(['1:full', '1:diagrams', '2:full', '2:diagrams']);
    expect(result.pages[1]!.text).toContain('Q32 (b)');
    expect(result.pages[1]!.text).toContain('[Diagram 1: Three lenses on an axis. Labels: L1 | L2 | L3 | 80 cm.]');
  });
});

describe('heading normalisation without the transcriber\'s help', () => {
  it('recognises a heading by its shape when the page report missed the number', async () => {
    const { normaliseHeadings } = await import('./transcribe.js');
    expect(normaliseHeadings("g32 (a) Lens maker's formula", [])).toBe("Q32 (a) Lens maker's formula");
    expect(normaliseHeadings('O33.', [])).toBe('Q33.');
    expect(normaliseHeadings('g32', [])).toBe('g32');
    expect(normaliseHeadings('0.5 m is the length', [])).toBe('0.5 m is the length');
  });
});

describe('degenerate transcripts', () => {
  const base = { diagrams: [], unclear: [], struck: [], questionNumbers: [31], legibility: 'good' as const };
  const lines = (text: string) => text.split('\n').map((entry, i) => ({ text: entry, top: i * 10, bottom: i * 10 + 8, left: 50, right: 900 }));

  it('spots a page that came back as marker after marker, or repeated over and over', async () => {
    const { looksDegenerate } = await import('./transcribe.js');
    const markers = Array.from({ length: 30 }, (_, i) => `[diagram ${i + 1}]`).join('\n');
    expect(looksDegenerate({ ...base, lines: lines(`Q31 (a)\n${markers}`) })).toBe(true);
    const page = ['The dipole has charges +q and -q seperated by 2a.', 'P is a point on the equatorial plane at a distance r.', 'Distance of P from each charge = sqrt(r^2 + a^2)', 'The components perpendicular to the axis cancel out.', 'So E = (E+q + E-q) cos theta where cos theta = a/r'].join('\n');
    expect(looksDegenerate({ ...base, lines: lines(`${page}\n${page}`) })).toBe(true);
    expect(looksDegenerate({ ...base, lines: lines('x'.repeat(8_000)) })).toBe(true);
    expect(looksDegenerate({ ...base, lines: lines('Q31 (a)\n[diagram 1]\nThe dipole has charges +q and -q.') })).toBe(false);
  });

  it('cleans a degenerate page without inventing anything, and says so', async () => {
    const { sanitiseTranscript } = await import('./transcribe.js');
    const cleaned = sanitiseTranscript({
      ...base,
      lines: lines('Q31 (a)\nThe dipole has charges +q and -q separated by 2a.\n[diagram 3]\n[diagram 4]\n[diagram 5]\nThe dipole has charges +q and -q separated by 2a.\nE = 2qa/r^3'),
    });
    expect(cleaned.lines.map((l) => l.text)).toEqual(['Q31 (a)', 'The dipole has charges +q and -q separated by 2a.', '[diagram 0]', 'E = 2qa/r^3']);
    expect(cleaned.legibility).toBe('poor');
    expect(cleaned.unclear[0]).toMatch(/unstable/);
    expect(composePageText(cleaned)).toContain('[Diagram: one or more drawings are present here but could not be described');
  });
});


describe('line positions', () => {
  it('accepts 0–1000, fractions and pixels, and rejects nonsense', () => {
    expect(normaliseBox({ top: 100, bottom: 200, left: 50, right: 950 })).toEqual({ top: 0.1, bottom: 0.2, left: 0.05, right: 0.95 });
    expect(normaliseBox({ top: 0.1, bottom: 0.2, left: 0.05, right: 0.95 })).toEqual({ top: 0.1, bottom: 0.2, left: 0.05, right: 0.95 });
    expect(normaliseBox({ top: 158, bottom: 316, left: 56, right: 1072 }, 1128, 1584)!.top).toBeCloseTo(0.0997, 3); // pixels of the rendered page
    expect(normaliseBox({ top: 1584 * 0.1, bottom: 1584 * 0.2, left: 1128 * 0.05, right: 1128 * 0.95 + 1000 }, 1128, 1584)).not.toBeNull();
    expect(normaliseBox({ top: 200, bottom: 200, left: 50, right: 950 })).toBeNull();
    expect(normaliseBox({ top: Number.NaN, bottom: 200, left: 50, right: 950 })).toBeNull();
  });

  it('turns positioned lines into runs the anchoring code can use, in fractions', () => {
    const page = buildPageText(3, 595, 842, [
      { text: 'Q31. (a)', box: { top: 0.05, bottom: 0.08, left: 0.1, right: 0.3 } },
      { text: 'E = 2qa/r^3', box: { top: 0.12, bottom: 0.15, left: 0.1, right: 0.6 } },
      { text: 'no box for this one', box: null },
    ]);
    expect(page.source).toBe('transcription');
    expect(page.text).toBe('Q31. (a)\nE = 2qa/r^3\nno box for this one');
    expect(page.runs).toHaveLength(2);
    expect(page.runs[1]).toMatchObject({ text: 'E = 2qa/r^3', start: 9, end: 20, rect: { page: 3, x: 0.1, y: 0.12 } });
    expect(page.runs[1]!.rect.width).toBeCloseTo(0.5);
    expect(page.runs[1]!.rect.height).toBeCloseTo(0.03);
  });

  it('drops every position when the boxes do not run down the page', () => {
    const page = buildPageText(0, 595, 842, [
      { text: 'first line of the answer', box: { top: 0.9, bottom: 0.92, left: 0.1, right: 0.9 } },
      { text: 'second line of the answer', box: { top: 0.5, bottom: 0.52, left: 0.1, right: 0.9 } },
      { text: 'third line of the answer', box: { top: 0.1, bottom: 0.12, left: 0.1, right: 0.9 } },
      { text: 'fourth line of the answer', box: { top: 0.7, bottom: 0.72, left: 0.1, right: 0.9 } },
    ]);
    expect(page.runs).toEqual([]);
    expect(page.text).toContain('third line');
  });
});

describe('snapLinesToInk', () => {
  it('moves each line onto the nearest unused row of ink, in order, and leaves drawings alone', async () => {
    const { snapLinesToInk } = await import('./transcribe.js');
    const rows = [
      { top: 0.1, bottom: 0.13, left: 0.15, right: 0.8 },
      { top: 0.2, bottom: 0.23, left: 0.15, right: 0.5 },
      { top: 0.6, bottom: 0.63, left: 0.15, right: 0.7 },
    ];
    const snapped = snapLinesToInk(
      [
        { text: 'first', box: { top: 0.05, bottom: 0.1, left: 0.1, right: 0.9 } }, // model said 5–10%, ink row is at 10–13%
        { text: 'second', box: { top: 0.15, bottom: 0.2, left: 0.1, right: 0.9 } },
        { text: '[Diagram 1: ...]', box: { top: 0.25, bottom: 0.55, left: 0.2, right: 0.7 } }, // tall: a drawing
        { text: 'third', box: { top: 0.65, bottom: 0.7, left: 0.1, right: 0.9 } }, // drifted below its row
        { text: 'far away', box: { top: 0.9, bottom: 0.95, left: 0.1, right: 0.9 } }, // no row near: keeps its box
      ],
      rows,
    );
    expect(snapped[0]!.box).toEqual(rows[0]);
    expect(snapped[1]!.box).toEqual(rows[1]);
    expect(snapped[2]!.box).toEqual({ top: 0.25, bottom: 0.55, left: 0.2, right: 0.7 });
    expect(snapped[3]!.box).toEqual(rows[2]);
    expect(snapped[4]!.box).toEqual({ top: 0.9, bottom: 0.95, left: 0.1, right: 0.9 });
  });

  it('gives a line with no box the next unused row when the line before it was placed', async () => {
    const { snapLinesToInk } = await import('./transcribe.js');
    const rows = [{ top: 0.1, bottom: 0.13, left: 0.1, right: 0.9 }, { top: 0.2, bottom: 0.23, left: 0.1, right: 0.6 }];
    const snapped = snapLinesToInk(
      [
        { text: 'placed', box: { top: 0.09, bottom: 0.13, left: 0.1, right: 0.9 } },
        { text: 'no estimate from the model', box: null },
      ],
      rows,
    );
    expect(snapped[1]!.box).toEqual(rows[1]);
  });

  it('never assigns the same row twice going backwards', async () => {
    const { snapLinesToInk } = await import('./transcribe.js');
    const rows = [{ top: 0.1, bottom: 0.13, left: 0.1, right: 0.9 }, { top: 0.2, bottom: 0.23, left: 0.1, right: 0.9 }];
    const snapped = snapLinesToInk(
      [
        { text: 'a', box: { top: 0.1, bottom: 0.14, left: 0.1, right: 0.9 } },
        { text: 'b', box: { top: 0.1, bottom: 0.14, left: 0.1, right: 0.9 } }, // model repeated the position
      ],
      rows,
    );
    expect(snapped[0]!.box).toEqual(rows[0]);
    expect(snapped[1]!.box).toEqual(rows[1]);
  });
});
