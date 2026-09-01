/**
 * Renders every authored answer paper in `answer-content.ts` to a PDF.
 *
 * Two reasons the papers are generated rather than hand-made in a word
 * processor. First, all five variants share one layout pipeline, so they are
 * consistent and a layout change applies everywhere. Second, generating them
 * means the diagrams are real vector drawings whose flaws (a voltmeter wired
 * into the main loop, a graph with its axes swapped) are precise and
 * reproducible instead of accidental.
 *
 * The output is a normal text-layer PDF. That is deliberate: it keeps quote
 * anchoring accurate without a handwriting-OCR stage, which the brief does not
 * ask for. See README § Why the student answer is a typed PDF.
 *
 *   npm run seed
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { ANSWER_SPECS, type AnswerSpec, type CircuitVariant, type GraphVariant } from './answer-content.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'fixtures', 'answers');

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 50;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;
const BODY_SIZE = 10.5;
const LINE_GAP = 2.5;

type Doc = PDFKit.PDFDocument;

/* ----------------------------- page furniture ---------------------------- */

function ensureSpace(doc: Doc, needed: number): void {
  if (doc.y + needed > PAGE.height - MARGIN) {
    doc.addPage();
  }
}

function drawHeader(doc: Doc, spec: AnswerSpec): void {
  doc.font('Times-Bold').fontSize(13).fillColor('#000');
  doc.text('GradeSense - Candidate Answer Sheet', MARGIN, MARGIN, {
    width: CONTENT_WIDTH,
    align: 'center',
  });

  doc.moveDown(0.4);
  doc.font('Times-Roman').fontSize(9.5);
  doc.text(`Name: ${spec.studentName}          Roll No: ${spec.rollNo}          Total marks: 15`, {
    width: CONTENT_WIDTH,
    align: 'center',
  });

  doc.moveDown(0.5);
  const ruleY = doc.y;
  doc.moveTo(MARGIN, ruleY).lineTo(PAGE.width - MARGIN, ruleY).lineWidth(0.8).strokeColor('#444').stroke();
  doc.y = ruleY + 12;
}

/** Roughly four and a half body lines of air between one answer and the next. */
const ANSWER_GAP = (BODY_SIZE + LINE_GAP) * 4.5;

/**
 * Separates one answer from the next.
 *
 * A single blank line left the three answers looking like one continuous essay,
 * which made the paper harder to read and the annotations harder to attribute to
 * a question. Skipped when the gap would land at the foot of a page — a page
 * break already provides all the separation needed, and a band of white space at
 * the top of a fresh page just looks like a mistake.
 */
function startNewAnswer(doc: Doc): void {
  if (doc.y + ANSWER_GAP + 60 > PAGE.height - MARGIN) {
    doc.addPage();
    return;
  }
  doc.y += ANSWER_GAP;
}

/**
 * Answer headings double as segmentation markers: the server splits the
 * extracted page text on /^Answer\s+(\d+)/ to decide which text belongs to
 * which question. Plain ASCII keeps that robust across PDF text extractors.
 */
function drawQuestionHeading(doc: Doc, number: number, subject: string): void {
  ensureSpace(doc, 40);
  doc.font('Times-Bold').fontSize(11).fillColor('#000');
  doc.text(`Answer ${number} - ${subject}`, MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.45);
}

function drawParagraphs(doc: Doc, content: { paragraphs: string[]; indentOverrides?: Record<number, number> }): void {
  doc.font('Times-Roman').fontSize(BODY_SIZE).fillColor('#111');

  content.paragraphs.forEach((paragraph, index) => {
    const indent = content.indentOverrides?.[index] ?? 0;
    ensureSpace(doc, 46);
    doc.text(paragraph, MARGIN + indent, doc.y, {
      width: CONTENT_WIDTH - indent,
      align: 'left',
      lineGap: LINE_GAP,
    });
    doc.moveDown(0.45);
  });
}

/* --------------------------- circuit primitives -------------------------- */

function wire(doc: Doc, x1: number, y1: number, x2: number, y2: number): void {
  doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(1).strokeColor('#111').stroke();
}

function label(doc: Doc, text: string, x: number, y: number, width = 90): void {
  doc.font('Times-Roman').fontSize(7.5).fillColor('#111');
  doc.text(text, x, y, { width, lineBreak: true });
}

/** Battery: a long plate and a short plate, drawn across a horizontal wire. */
function batterySymbol(doc: Doc, cx: number, cy: number): void {
  doc.moveTo(cx - 4, cy - 11).lineTo(cx - 4, cy + 11).lineWidth(1.6).strokeColor('#111').stroke();
  doc.moveTo(cx + 4, cy - 6).lineTo(cx + 4, cy + 6).lineWidth(3).strokeColor('#111').stroke();
}

/** Open-style switch: a gap in the wire bridged by an angled lever. */
function switchSymbol(doc: Doc, x: number, y: number, width = 26): void {
  doc.circle(x, y, 1.6).fillColor('#111').fill();
  doc.circle(x + width, y, 1.6).fillColor('#111').fill();
  doc.moveTo(x, y).lineTo(x + width - 5, y - 11).lineWidth(1.2).strokeColor('#111').stroke();
}

/** Resistor: a five-peak zigzag. */
function resistorSymbol(doc: Doc, x: number, y: number, width = 40): void {
  const step = width / 6;
  doc.moveTo(x, y).lineWidth(1.2).strokeColor('#111');
  for (let i = 0; i < 6; i += 1) {
    const peakY = i % 2 === 0 ? y - 7 : y + 7;
    doc.lineTo(x + step * (i + 0.5), peakY);
  }
  doc.lineTo(x + width, y).stroke();
}

/** Bulb: a circle with a cross through it. */
function bulbSymbol(doc: Doc, cx: number, cy: number, r = 11): void {
  doc.circle(cx, cy, r).lineWidth(1.2).strokeColor('#111').stroke();
  const d = r * 0.7;
  doc.moveTo(cx - d, cy - d).lineTo(cx + d, cy + d).lineWidth(1).stroke();
  doc.moveTo(cx + d, cy - d).lineTo(cx - d, cy + d).lineWidth(1).stroke();
}

/** Meter: a circle carrying a single letter (A for ammeter, V for voltmeter). */
function meterSymbol(doc: Doc, cx: number, cy: number, letter: string, r = 11): void {
  doc.circle(cx, cy, r).lineWidth(1.2).strokeColor('#111').stroke();
  doc.font('Times-Bold').fontSize(9).fillColor('#111');
  doc.text(letter, cx - 3.2, cy - 4.6, { lineBreak: false });
}

function currentArrow(doc: Doc, x: number, y: number): void {
  doc.moveTo(x, y + 16).lineTo(x, y - 16).lineWidth(1).strokeColor('#111').stroke();
  doc.moveTo(x - 3.5, y - 10).lineTo(x, y - 17).lineTo(x + 3.5, y - 10).lineWidth(1).stroke();
}

/**
 * Draws the circuit and returns the height consumed.
 *
 * `overflowsMargin` widens the loop past the right text margin, which is one of
 * the planted layout faults on the flagship paper — it also pushes the ammeter
 * label into the wire, producing a real label collision rather than a described
 * one.
 */
function drawCircuit(doc: Doc, variant: CircuitVariant, overflowsMargin: boolean): number {
  if (variant === 'none') return 0;

  const height = 210;
  ensureSpace(doc, height + 16);

  doc.font('Times-Bold').fontSize(8.5).fillColor('#111');
  doc.text('Circuit diagram', MARGIN, doc.y + 6, { width: CONTENT_WIDTH });

  // Leave a band above the top wire for the component labels, so the caption
  // and the labels never share a line.
  const top = doc.y + 34;
  const left = MARGIN + 46;
  const right = overflowsMargin ? PAGE.width - MARGIN + 18 : PAGE.width - MARGIN - 66;
  const bottom = top + 120;
  const midX = (left + right) / 2;

  if (variant === 'sparse') {
    // Deliberately impoverished: a battery and a bulb, no meters, no labels
    // beyond the two components, and a visible gap in the loop.
    wire(doc, left, top, right - 40, top);
    wire(doc, right - 40, top, right - 40, bottom);
    wire(doc, right - 40, bottom, left + 60, bottom);
    wire(doc, left, top, left, bottom - 30);
    batterySymbol(doc, left + 60, top);
    bulbSymbol(doc, midX - 20, bottom);
    label(doc, 'battery', left + 40, top - 26);
    label(doc, 'bulb', midX - 32, bottom + 14);
    doc.y = bottom + 40;
    return height;
  }

  // Main loop, shared by the correct and voltmeter-in-series variants.
  const switchX = left + 78;
  const resistorX = midX + 34;

  wire(doc, left, top, switchX, top);
  switchSymbol(doc, switchX, top);
  wire(doc, switchX + 26, top, resistorX, top);
  resistorSymbol(doc, resistorX, top);
  wire(doc, resistorX + 40, top, right, top);

  wire(doc, right, top, right, bottom);
  const ammeterY = (top + bottom) / 2;
  meterSymbol(doc, right, ammeterY, 'A');

  wire(doc, left, top, left, bottom);
  batterySymbol(doc, left + 34, top);

  if (variant === 'correct') {
    // Bulb in the bottom wire; voltmeter on a parallel branch beneath it.
    wire(doc, left, bottom, midX - 11, bottom);
    bulbSymbol(doc, midX, bottom);
    wire(doc, midX + 11, bottom, right, bottom);

    const tapLeft = midX - 46;
    const tapRight = midX + 46;
    const branchY = bottom + 44;
    doc.circle(tapLeft, bottom, 1.8).fillColor('#111').fill();
    doc.circle(tapRight, bottom, 1.8).fillColor('#111').fill();
    wire(doc, tapLeft, bottom, tapLeft, branchY);
    wire(doc, tapLeft, branchY, midX - 11, branchY);
    meterSymbol(doc, midX, branchY, 'V');
    wire(doc, midX + 11, branchY, tapRight, branchY);
    wire(doc, tapRight, branchY, tapRight, bottom);

    label(doc, 'voltmeter (parallel across bulb)', midX + 20, branchY - 5, 120);
    currentArrow(doc, left - 22, ammeterY);
    label(doc, 'conventional current', left - 44, ammeterY + 22, 84);
  } else {
    // Planted error: the voltmeter sits in the main loop, in series with the
    // bulb, so the same current passes through both.
    wire(doc, left, bottom, midX - 57, bottom);
    meterSymbol(doc, midX - 46, bottom, 'V');
    wire(doc, midX - 35, bottom, midX - 11, bottom);
    bulbSymbol(doc, midX, bottom);
    wire(doc, midX + 11, bottom, right, bottom);
    label(doc, 'voltmeter', midX - 72, bottom + 16, 60);
    // No current-direction arrow on this variant — that omission is what costs
    // the presentation mark.
  }

  label(doc, 'battery', left + 14, top - 26);
  label(doc, 'switch', switchX - 4, top - 28);
  label(doc, 'resistor', resistorX + 4, top - 26);
  label(doc, 'bulb', midX - 8, bottom + 16);
  // On the overflowing variant this label lands on top of the right-hand wire —
  // a genuine label collision, not a described one. Otherwise it sits clear of
  // the loop.
  // The flagship paper carries the student's misspelling into the diagram too.
  const ammeterLabel = variant === 'voltmeter-in-series' ? 'ameter' : 'ammeter';
  label(doc, ammeterLabel, overflowsMargin ? right - 6 : right + 8, ammeterY - 4, 44);

  doc.y = bottom + (variant === 'correct' ? 74 : 44);
  return height;
}

/* ---------------------------- graph primitives --------------------------- */

/**
 * Draws the demand/supply graph and returns the height consumed.
 *
 * The `axes-swapped` variant plots price along the horizontal axis and leaves
 * both axes unlabelled — a common real student error, and a good test of
 * diagram annotation because there is no text to quote.
 */
function drawGraph(doc: Doc, variant: GraphVariant): number {
  if (variant === 'none') return 0;

  const height = 210;
  ensureSpace(doc, height + 16);

  doc.font('Times-Bold').fontSize(8.5).fillColor('#111');
  doc.text('Demand and supply graph', MARGIN, doc.y + 4, { width: CONTENT_WIDTH });

  const originX = MARGIN + 66;
  const originY = doc.y + 154;
  const axisW = 250;
  const axisH = 132;

  // Axes.
  doc.moveTo(originX, originY - axisH).lineTo(originX, originY).lineTo(originX + axisW, originY);
  doc.lineWidth(1.1).strokeColor('#111').stroke();

  const plot = (fx: number, fy: number) => ({
    x: originX + fx * axisW,
    y: originY - fy * axisH,
  });

  const line = (from: { x: number; y: number }, to: { x: number; y: number }, dashed = false) => {
    doc.moveTo(from.x, from.y).lineTo(to.x, to.y).lineWidth(1.3).strokeColor('#111');
    if (dashed) doc.dash(3, { space: 2 });
    doc.stroke();
    if (dashed) doc.undash();
  };

  if (variant === 'correct') {
    // Quantity horizontal, price vertical — both labelled.
    const demandFrom = plot(0.08, 0.92);
    const demandTo = plot(0.92, 0.1);
    const supplyFrom = plot(0.08, 0.1);
    const supplyTo = plot(0.92, 0.92);
    line(demandFrom, demandTo);
    line(supplyFrom, supplyTo);

    const eq = plot(0.5, 0.51);
    doc.circle(eq.x, eq.y, 2.6).fillColor('#111').fill();
    doc.moveTo(originX, eq.y).lineTo(eq.x, eq.y).lineWidth(0.6).dash(2, { space: 2 }).strokeColor('#555').stroke();
    doc.moveTo(eq.x, originY).lineTo(eq.x, eq.y).lineWidth(0.6).strokeColor('#555').stroke();
    doc.undash();

    // Leftward supply shift after a cost increase.
    line(plot(-0.06, 0.26), plot(0.72, 1.0), true);

    label(doc, 'Price (Rs)', originX - 58, originY - axisH - 4, 54);
    label(doc, 'Quantity', originX + axisW - 34, originY + 8, 60);
    label(doc, 'D', demandTo.x + 4, demandTo.y - 4, 14);
    label(doc, 'S', supplyTo.x + 4, supplyTo.y - 4, 14);
    label(doc, 'S1 (after cost rise)', plot(0.72, 1.0).x + 4, plot(0.72, 1.0).y - 6, 76);
    label(doc, 'E (Rs 30, 60 units)', eq.x + 6, eq.y - 12, 84);
    label(doc, '30', originX - 16, eq.y - 4, 16);
    label(doc, '60', eq.x - 5, originY + 6, 16);
  } else if (variant === 'both-upward') {
    const a = plot(0.08, 0.12);
    const b = plot(0.92, 0.86);
    const c = plot(0.08, 0.3);
    const d = plot(0.92, 1.0);
    line(a, b);
    line(c, d);
    label(doc, 'D', b.x + 4, b.y - 4, 14);
    label(doc, 'S', d.x + 4, d.y - 4, 14);
    label(doc, 'Price', originX + axisW - 26, originY + 8, 40);
  } else {
    // axes-swapped: price runs along the horizontal axis, quantity up the
    // vertical, and neither axis carries a label.
    const demandFrom = plot(0.08, 0.9);
    const demandTo = plot(0.92, 0.12);
    const supplyFrom = plot(0.08, 0.12);
    const supplyTo = plot(0.92, 0.9);
    line(demandFrom, demandTo);
    line(supplyFrom, supplyTo);

    const eq = plot(0.5, 0.51);
    doc.circle(eq.x, eq.y, 2.6).fillColor('#111').fill();

    label(doc, 'D', demandTo.x + 4, demandTo.y - 4, 14);
    label(doc, 'S', supplyTo.x + 4, supplyTo.y - 4, 14);
    label(doc, 'E', eq.x + 5, eq.y - 11, 14);
    // Tick values give the axis meaning away without ever naming the axes.
    label(doc, '10', plot(0.08, 0).x - 5, originY + 6, 16);
    label(doc, '30', eq.x - 5, originY + 6, 16);
    label(doc, '50', plot(0.92, 0).x - 5, originY + 6, 16);
  }

  doc.y = originY + 30;
  return height;
}

/* ------------------------------- generation ------------------------------ */

function renderAnswer(spec: AnswerSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    const outPath = path.join(OUT_DIR, `${spec.slug}.pdf`);
    const doc = new PDFDocument({
      size: [PAGE.width, PAGE.height],
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      info: { Title: spec.title, Author: spec.studentName, Subject: 'GradeSense candidate answer' },
    });

    const stream = fs.createWriteStream(outPath);
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.pipe(stream);

    drawHeader(doc, spec);

    drawQuestionHeading(doc, 1, 'Science');
    drawParagraphs(doc, spec.q1);
    drawCircuit(doc, spec.q1.circuit, spec.q1.circuitOverflowsMargin);

    startNewAnswer(doc);
    drawQuestionHeading(doc, 2, 'English');
    drawParagraphs(doc, spec.q2);

    startNewAnswer(doc);
    drawQuestionHeading(doc, 3, 'Economics');
    drawParagraphs(doc, spec.q3);
    drawGraph(doc, spec.q3.graph);

    doc.end();
  });
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const spec of ANSWER_SPECS) {
    await renderAnswer(spec);
    console.log(`  ${spec.slug}.pdf  —  ${spec.intent.split('.')[0]}`);
  }

  console.log(`\n${ANSWER_SPECS.length} answer papers written to fixtures/answers/`);
}

main().catch((error: unknown) => {
  console.error('Failed to generate answer papers:', error);
  process.exitCode = 1;
});
