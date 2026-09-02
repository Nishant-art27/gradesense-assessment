/**
 * Builds the three PDFs in `recording_sample/`, the demo bundle used when
 * recording a GradeSense walkthrough.
 *
 *   1. question-paper.pdf  - three questions lifted verbatim from CBSE Class XII
 *                            Physics 2026, Q.P. code 55/1/1 (Section E).
 *   2. marking-scheme.pdf  - the award list and value points for those three
 *                            questions, transcribed from the official CBSE
 *                            marking scheme for 55/1/1.
 *   3. student-answer.pdf  - a candidate script for the same three questions.
 *
 * The first two are typeset in Times New Roman; the third is drawn in a
 * handwriting face on ruled paper with per-line jitter, because a demo of a
 * grading tool is more convincing against something that looks like a real
 * answer booklet than against a word-processed page.
 *
 * No genuine student script for the 2026 paper is published anywhere, so the
 * answers are authored here. They are deliberately imperfect: each question
 * carries one or two errors of the kind the marking scheme actually penalises
 * (a missing direction, a misread geometry, a dropped term, an unconverted
 * unit), so a grader has something to find and the awarded total lands around
 * 11.5 of 15 rather than at either extreme.
 *
 * Glyph note: the two embedded faces have no arrow, no U+207B superscript
 * minus and no "therefore"/"because" signs, so negative powers are written
 * `10^-3` and those symbols are spelled out.
 *
 *   npx tsx scripts/generate-recording-sample.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'recording_sample');

const FONTS = {
  serif: '/System/Library/Fonts/Supplemental/Times New Roman.ttf',
  serifBold: '/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf',
  serifItalic: '/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf',
  hand: '/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf',
};

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 54;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;

type Doc = PDFKit.PDFDocument;

/**
 * `margins` is set to zero for the ruled answer sheet. Every glyph there is
 * placed at an absolute coordinate, and a non-zero bottom margin makes pdfkit
 * insert a page of its own whenever a label lands below it - which desynchronises
 * the sheet's own page counter and leaves stray blank pages behind.
 */
function newDoc(title: string, subject: string, margin = MARGIN): Doc {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: margin, bottom: margin, left: margin, right: margin },
    info: { Title: title, Subject: subject, Author: 'GradeSense recording sample' },
    autoFirstPage: true,
  });
  doc.registerFont('serif', FONTS.serif);
  doc.registerFont('serif-bold', FONTS.serifBold);
  doc.registerFont('serif-italic', FONTS.serifItalic);
  doc.registerFont('hand', FONTS.hand);
  return doc;
}

function write(doc: Doc, file: string): Promise<void> {
  const stream = fs.createWriteStream(path.join(OUT_DIR, file));
  doc.pipe(stream);
  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });
}

/* =============================== shared bits ============================== */

function rule(doc: Doc, y: number, weight = 0.8, colour = '#333'): void {
  doc.moveTo(MARGIN, y).lineTo(PAGE.width - MARGIN, y).lineWidth(weight).strokeColor(colour).stroke();
}

function ensureSpace(doc: Doc, needed: number): void {
  if (doc.y + needed > PAGE.height - MARGIN) doc.addPage();
}

/** A centred display line, used for the equations in the marking scheme. */
function display(doc: Doc, text: string, marks?: string): void {
  ensureSpace(doc, 26);
  const y = doc.y;
  doc.font('serif-italic').fontSize(10.5).fillColor('#111');
  doc.text(text, MARGIN + 28, y, { width: CONTENT_WIDTH - 130, lineGap: 2 });
  // The marks column is one line tall whatever the equation does, so restore the
  // cursor the equation left behind - otherwise a wrapped equation is overwritten.
  const after = doc.y;
  if (marks) {
    doc.font('serif').fontSize(9.5).fillColor('#444');
    doc.text(marks, PAGE.width - MARGIN - 60, y, { width: 60, align: 'right' });
  }
  doc.y = after;
  doc.moveDown(0.3);
}

/* ============================ vector diagrams ============================= */

function arrow(doc: Doc, x1: number, y1: number, x2: number, y2: number, colour = '#111'): void {
  doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(1).strokeColor(colour).stroke();
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = 5;
  doc
    .moveTo(x2, y2)
    .lineTo(x2 - head * Math.cos(angle - 0.4), y2 - head * Math.sin(angle - 0.4))
    .lineTo(x2 - head * Math.cos(angle + 0.4), y2 - head * Math.sin(angle + 0.4))
    .closePath()
    .fillColor(colour)
    .fill();
}

function tag(doc: Doc, text: string, x: number, y: number, font = 'serif', size = 8): void {
  doc.font(font).fontSize(size).fillColor('#111');
  doc.text(text, x, y, { lineBreak: false });
}

/** +q and -q on a horizontal axis, with the equatorial point P and its two fields. */
function dipoleFigure(doc: Doc, top: number, font = 'serif'): number {
  // py - 32 is the highest ink in this figure, so the point sits far enough below
  // `top` that the E+q label stays inside the band the caller reserved.
  const height = 134;
  const cx = MARGIN + 170;
  const axisY = top + 108;
  const half = 46;
  const px = cx;
  const py = top + 34;

  doc.moveTo(cx - half - 34, axisY).lineTo(cx + half + 34, axisY).lineWidth(0.8).strokeColor('#555').stroke();
  doc.circle(cx - half, axisY, 3).fillColor('#111').fill();
  doc.circle(cx + half, axisY, 3).fillColor('#111').fill();
  tag(doc, '+q', cx - half - 6, axisY + 7, font);
  tag(doc, '-q', cx + half - 4, axisY + 7, font);
  tag(doc, 'O', cx - 3, axisY + 7, font);
  tag(doc, '2a', cx - 6, axisY + 20, font);
  doc.moveTo(cx - half, axisY + 17).lineTo(cx + half, axisY + 17).lineWidth(0.5).strokeColor('#777').stroke();

  // r from centre to P, and the two field vectors at P.
  doc.moveTo(cx, axisY).lineTo(px, py).lineWidth(0.7).dash(2, { space: 2 }).strokeColor('#777').stroke();
  doc.undash();
  tag(doc, 'r', cx + 4, (axisY + py) / 2, font);
  doc.circle(px, py, 2.2).fillColor('#111').fill();
  tag(doc, 'P', px - 12, py - 4, font);

  arrow(doc, px, py, px + 52, py - 24); // E due to +q, pointing away from +q
  arrow(doc, px, py, px + 52, py + 24); // E due to -q, pointing towards -q
  arrow(doc, px, py, px + 60, py, '#c1272d'); // resultant, antiparallel to p
  tag(doc, 'E+q', px + 54, py - 32, font);
  tag(doc, 'E-q', px + 54, py + 22, font);
  tag(doc, 'E at P', px + 64, py - 4, font);

  return height;
}

/** A thin lens with the object, the intermediate image and the final image on one axis. */
function lensMakerFigure(doc: Doc, top: number, font = 'serif'): number {
  const height = 96;
  const axisY = top + 50;
  const lensX = MARGIN + 190;
  const left = MARGIN + 40;
  const right = PAGE.width - MARGIN - 60;

  doc.moveTo(left - 20, axisY).lineTo(right, axisY).lineWidth(0.8).strokeColor('#555').stroke();
  // Lens: two arcs meeting at top and bottom.
  doc.moveTo(lensX, axisY - 36).bezierCurveTo(lensX + 16, axisY - 12, lensX + 16, axisY + 12, lensX, axisY + 36);
  doc.bezierCurveTo(lensX - 16, axisY + 12, lensX - 16, axisY - 12, lensX, axisY - 36);
  doc.lineWidth(1).strokeColor('#111').stroke();

  doc.circle(left, axisY, 2.5).fillColor('#111').fill();
  tag(doc, 'O', left - 4, axisY + 8, font);
  const iX = lensX + 78;
  const i1X = lensX + 148;
  doc.circle(iX, axisY, 2.5).fillColor('#111').fill();
  doc.circle(i1X, axisY, 2.5).fillColor('#111').fill();
  tag(doc, 'I', iX - 2, axisY + 8, font);
  tag(doc, 'I1', i1X - 4, axisY + 8, font);
  tag(doc, 'B', lensX - 14, axisY - 10, font);
  tag(doc, 'D', lensX + 8, axisY - 10, font);
  tag(doc, 'A', lensX - 4, axisY - 46, font);
  tag(doc, 'C', lensX - 4, axisY + 40, font);

  // Ray to the rim and on to the two image points.
  doc.moveTo(left, axisY).lineTo(lensX, axisY - 34).lineWidth(0.8).strokeColor('#111').stroke();
  doc.moveTo(lensX, axisY - 34).lineTo(iX, axisY).lineWidth(0.8).strokeColor('#111').stroke();
  doc.moveTo(lensX, axisY - 34).lineTo(i1X, axisY).lineWidth(0.7).dash(3, { space: 2 }).strokeColor('#777').stroke();
  doc.undash();

  tag(doc, 'u', (left + lensX) / 2 - 4, axisY + 22, font);
  tag(doc, 'v', (lensX + iX) / 2 - 4, axisY + 22, font);
  return height;
}

/** Three coaxial lenses with the object and the inter-lens separations marked. */
function threeLensFigure(doc: Doc, top: number, font = 'serif'): number {
  const height = 92;
  const axisY = top + 44;
  const objX = MARGIN + 26;
  const xs = [objX + 62, objX + 152, objX + 200];

  doc.moveTo(objX - 12, axisY).lineTo(PAGE.width - MARGIN - 30, axisY).lineWidth(0.8).strokeColor('#555').stroke();
  doc.circle(objX, axisY, 2.5).fillColor('#c1272d').fill();
  tag(doc, 'O', objX - 4, axisY + 8, font);

  xs.forEach((x, i) => {
    doc.moveTo(x, axisY - 26).bezierCurveTo(x + 11, axisY - 9, x + 11, axisY + 9, x, axisY + 26);
    doc.bezierCurveTo(x - 11, axisY + 9, x - 11, axisY - 9, x, axisY - 26);
    doc.lineWidth(1).strokeColor('#111').stroke();
    tag(doc, `L${i + 1}`, x - 5, axisY - 40, font);
  });

  const dimY = axisY + 34;
  const spans: Array<[number, number, string]> = [
    [objX, xs[0], '80 cm'],
    [xs[0], xs[1], '120 cm'],
    [xs[1], xs[2], '20 cm'],
  ];
  for (const [a, b, text] of spans) {
    doc.moveTo(a, dimY).lineTo(b, dimY).lineWidth(0.5).strokeColor('#777').stroke();
    doc.moveTo(a, dimY - 3).lineTo(a, dimY + 3).stroke();
    doc.moveTo(b, dimY - 3).lineTo(b, dimY + 3).stroke();
    tag(doc, text, (a + b) / 2 - 12, dimY + 4, font, 7.5);
  }
  return height;
}

/** A long solenoid: an outline plus a run of turns, with l and A called out. */
function solenoidFigure(doc: Doc, top: number, font = 'serif'): number {
  const height = 92;
  const x0 = MARGIN + 60;
  const x1 = x0 + 210;
  const midY = top + 42;
  const r = 18;

  doc.moveTo(x0, midY - r).lineTo(x1, midY - r).lineWidth(0.8).strokeColor('#888').stroke();
  doc.moveTo(x0, midY + r).lineTo(x1, midY + r).lineWidth(0.8).strokeColor('#888').stroke();

  const turns = 14;
  for (let i = 0; i < turns; i += 1) {
    const x = x0 + ((x1 - x0) / turns) * (i + 0.5);
    doc.ellipse(x, midY, 3.5, r).lineWidth(0.9).strokeColor('#111').stroke();
  }

  doc.moveTo(x0 - 22, midY - r).lineTo(x0, midY - r).lineWidth(0.9).strokeColor('#111').stroke();
  doc.moveTo(x0 - 22, midY + r).lineTo(x0, midY + r).lineWidth(0.9).strokeColor('#111').stroke();

  const dimY = midY + r + 16;
  doc.moveTo(x0, dimY).lineTo(x1, dimY).lineWidth(0.5).strokeColor('#777').stroke();
  doc.moveTo(x0, dimY - 3).lineTo(x0, dimY + 3).stroke();
  doc.moveTo(x1, dimY - 3).lineTo(x1, dimY + 3).stroke();
  tag(doc, 'length l, N turns', (x0 + x1) / 2 - 32, dimY + 4, font, 7.5);
  tag(doc, 'area A', x1 + 8, midY - 4, font, 7.5);
  arrow(doc, x0 + 60, midY, x0 + 130, midY, '#c1272d');
  tag(doc, 'B = mu0 n I', x0 + 62, midY - r - 12, font, 7.5);
  return height;
}

/** Rod pivoted at one end sweeping a field that points into the page. */
function rotatingRodFigure(doc: Doc, top: number, font = 'serif'): number {
  // All three callouts are pushed clear of the field-marker grid: two above and
  // below it, one to its right.
  const height = 126;
  const ox = MARGIN + 90;
  const oy = top + 62;
  const len = 86;

  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      const x = ox - 34 + i * 44;
      const y = oy - 40 + j * 40;
      doc.circle(x, y, 4).lineWidth(0.6).strokeColor('#888').stroke();
      doc.moveTo(x - 2.8, y - 2.8).lineTo(x + 2.8, y + 2.8).stroke();
      doc.moveTo(x + 2.8, y - 2.8).lineTo(x - 2.8, y + 2.8).stroke();
    }
  }

  doc.circle(ox, oy, 3.2).fillColor('#111').fill();
  doc.moveTo(ox, oy).lineTo(ox + len, oy - 26).lineWidth(2).strokeColor('#111').stroke();
  tag(doc, 'O', ox - 12, oy + 5, font);
  tag(doc, 'rod, l = 50 cm', ox + 16, oy - 58, font, 7.5);

  doc.moveTo(ox + 34, oy);
  for (let t = 0; t <= 1; t += 0.05) {
    const a = -0.15 + t * 1.0;
    doc.lineTo(ox + 34 * Math.cos(a), oy + 34 * Math.sin(a));
  }
  doc.lineWidth(0.8).strokeColor('#c1272d').stroke();
  tag(doc, 'omega = 60 rpm', ox + 12, oy + 54, font, 7.5);
  tag(doc, 'B into the page (4.0 mT)', ox + 122, oy - 4, font, 7.5);
  return height;
}

/* ========================= 1. question paper extract ====================== */

async function buildQuestionPaper(): Promise<void> {
  const doc = newDoc('CBSE 2026 Physics 55/1/1 - Section E extract', 'Question paper');

  doc.font('serif-bold').fontSize(14).fillColor('#000');
  doc.text('PHYSICS (Theory)', MARGIN, MARGIN, { width: CONTENT_WIDTH, align: 'center' });
  doc.font('serif').fontSize(10.5);
  doc.text('Central Board of Secondary Education - Class XII Board Examination, 2026', {
    width: CONTENT_WIDTH,
    align: 'center',
  });
  doc.text('Subject Code 042      Q.P. Code 55/1/1 (Series QPSR1, Set 1)', {
    width: CONTENT_WIDTH,
    align: 'center',
  });
  doc.moveDown(0.4);
  doc.font('serif-italic').fontSize(9.5).fillColor('#444');
  doc.text('Extract: Section E, questions 31 to 33. Time allowed for the full paper: 3 hours. Maximum marks: 70.', {
    width: CONTENT_WIDTH,
    align: 'center',
  });
  doc.moveDown(0.6);
  rule(doc, doc.y);
  doc.y += 12;

  doc.font('serif').fontSize(10).fillColor('#333');
  doc.text(
    'General instruction for this section: questions 31 to 33 are long answer type questions carrying 5 marks each. ' +
      'An internal choice is provided in each question; attempt any one of the alternatives.',
    MARGIN,
    doc.y,
    { width: CONTENT_WIDTH, lineGap: 2.5 },
  );
  doc.moveDown(0.9);

  doc.font('serif-bold').fontSize(11.5).fillColor('#000');
  doc.text('SECTION - E', MARGIN, doc.y, { width: CONTENT_WIDTH, align: 'center' });
  doc.moveDown(0.7);

  type Part = { label: string; text: string; figure?: (doc: Doc, top: number) => number };
  type Question = { number: number; marks: number; parts: Part[]; alternative: Part[] };

  const questions: Question[] = [
    {
      number: 31,
      marks: 5,
      parts: [
        {
          label: '(a)',
          text:
            'An electric dipole consists of two point charges q and -q separated by a distance 2a. Derive an expression ' +
            'for the electric field E due to this dipole at a point distant r from the centre of the dipole on the ' +
            'equatorial plane. Write the expression for the electric field at a far off point, i.e. r >> a.',
        },
        {
          label: '(b)',
          text:
            'A dipole is placed in x-y plane such that charges q and -q are located at x = a and x = b respectively. ' +
            'There exists an electric field E = 2 i N/C in the region. Calculate the force F and torque t experienced ' +
            'by the dipole.',
        },
      ],
      alternative: [
        {
          label: '(a)',
          text:
            'Two cells of emf E1 and E2 with internal resistances r1 and r2 respectively, are connected in parallel by ' +
            'connecting their positive terminals together and negative terminals together. Deduce an expression for ' +
            'equivalent emf and equivalent internal resistance of the combination.',
        },
        {
          label: '(b)',
          text:
            'A parallel combination, as stated in (a) above, of two cells of emfs E and 3E and internal resistances R ' +
            'each is connected across a resistance 2R. Find the current that flows through resistance 2R.',
        },
      ],
    },
    {
      number: 32,
      marks: 5,
      parts: [
        {
          label: '(a)',
          text: "Using the relation for refraction at a curved spherical surface, derive the expression for lens maker's formula.",
        },
        {
          label: '(b)',
          text:
            'Three lenses L1, L2 and L3, each of focal length 40 cm, are placed coaxially. The distance between L1 and ' +
            'L2 and between L2 and L3 are 120 cm and 20 cm respectively. An object is kept at a distance of 80 cm to the ' +
            'left of lens L1. Find the distance of the final image formed from the object.',
          figure: (d, top) => threeLensFigure(d, top),
        },
      ],
      alternative: [
        {
          label: '(a)',
          text:
            'Draw a ray diagram to show the image formation by a concave mirror when the object is kept between its ' +
            'focus and the centre of curvature. Using this diagram, derive the mirror formula.',
        },
        {
          label: '(b)',
          text:
            'A concave mirror produces a two times magnified virtual image of an object kept 10 cm in front of it. ' +
            'Calculate the focal length of the mirror.',
        },
      ],
    },
    {
      number: 33,
      marks: 5,
      parts: [
        { label: '(a)', text: "State Faraday's law of electromagnetic induction." },
        {
          label: '(b)',
          text:
            'Derive an expression for the self-inductance of an air-filled long solenoid of length l and ' +
            'cross-sectional area A having N turns.',
        },
        {
          label: '(c)',
          text:
            'A conducting rod of length 50 cm, with one end pivoted, is rotated with angular speed of 60 rpm in a ' +
            'uniform magnetic field of 4.0 mT directed perpendicular to the plane of rotation of rod. Find the emf ' +
            'induced in the rod.',
        },
      ],
      alternative: [
        {
          label: '(a)',
          text:
            'Draw a labelled diagram of a step-up transformer. State the principle on which it works and obtain the ' +
            'ratio of secondary voltage to primary voltage in terms of number of turns and currents in the two coils.',
        },
        {
          label: '(b)',
          text:
            'The ratio of the number of turns in the primary to the secondary of an ideal transformer is 1 : 5. If 5 kW ' +
            'power at 200 V is supplied to the primary, find (i) current in the primary, and (ii) output voltage.',
        },
      ],
    },
  ];

  for (const question of questions) {
    ensureSpace(doc, 120);
    const headY = doc.y;
    doc.font('serif-bold').fontSize(11).fillColor('#000');
    doc.text(`${question.number}.`, MARGIN, headY, { width: 24, lineBreak: false });
    doc.font('serif').fontSize(9.5).fillColor('#444');
    doc.text(`${question.marks}`, PAGE.width - MARGIN - 40, headY, { width: 40, align: 'right' });
    doc.y = headY;

    const renderParts = (parts: Part[]) => {
      for (const part of parts) {
        ensureSpace(doc, 56);
        const y = doc.y;
        doc.font('serif').fontSize(10.5).fillColor('#111');
        doc.text(part.label, MARGIN + 24, y, { width: 22, lineBreak: false });
        doc.text(part.text, MARGIN + 46, y, { width: CONTENT_WIDTH - 92, lineGap: 2.5 });
        doc.moveDown(0.4);
        if (part.figure) {
          ensureSpace(doc, 110);
          doc.y += part.figure(doc, doc.y) + 8;
        }
      }
    };

    renderParts(question.parts);

    doc.moveDown(0.2);
    ensureSpace(doc, 40);
    doc.font('serif-bold').fontSize(10.5).fillColor('#000');
    doc.text('OR', MARGIN, doc.y, { width: CONTENT_WIDTH, align: 'center' });
    doc.moveDown(0.35);
    renderParts(question.alternative);
    doc.moveDown(0.8);
  }

  ensureSpace(doc, 60);
  rule(doc, doc.y, 0.5, '#999');
  doc.y += 8;
  doc.font('serif-italic').fontSize(8.5).fillColor('#666');
  doc.text(
    'Reproduced from the CBSE Class XII Physics (042) board question paper of 2026, Q.P. code 55/1/1, for use as a ' +
      'GradeSense demonstration sample. Vector quantities printed in bold in the original are set in plain type here.',
    MARGIN,
    doc.y,
    { width: CONTENT_WIDTH, lineGap: 2 },
  );

  await write(doc, 'question-paper.pdf');
}

/* ============================ 2. marking scheme =========================== */

type Award = { text: string; marks: string };
type SchemeStep = { kind: 'text' | 'eq' | 'note'; text: string; marks?: string };
type SchemeBlock = {
  heading: string;
  awards: Award[];
  steps: SchemeStep[];
  figure?: (doc: Doc, top: number) => number;
  total: string;
};

async function buildMarkingScheme(): Promise<void> {
  const doc = newDoc('CBSE 2026 Physics 55/1/1 - marking scheme, Q31 to Q33', 'Marking scheme');

  doc.font('serif-bold').fontSize(14).fillColor('#000');
  doc.text('MARKING SCHEME', MARGIN, MARGIN, { width: CONTENT_WIDTH, align: 'center' });
  doc.font('serif').fontSize(10.5);
  doc.text('PHYSICS (042) - Class XII, 2026      Q.P. Code 55/1/1', { width: CONTENT_WIDTH, align: 'center' });
  doc.moveDown(0.35);
  doc.font('serif-italic').fontSize(9.5).fillColor('#444');
  doc.text('Section E, questions 31 to 33 (5 marks each). Value points and distribution of marks.', {
    width: CONTENT_WIDTH,
    align: 'center',
  });
  doc.moveDown(0.6);
  rule(doc, doc.y);
  doc.y += 12;

  doc.font('serif').fontSize(9.5).fillColor('#333');
  doc.text(
    'General instructions to examiners: award marks step-wise as indicated. Where a candidate uses any other correct ' +
      'method, award full marks. In questions carrying an internal choice, mark the alternative actually attempted.',
    MARGIN,
    doc.y,
    { width: CONTENT_WIDTH, lineGap: 2.5 },
  );
  doc.moveDown(0.9);

  const blocks: SchemeBlock[] = [
    {
      heading: 'Q31 (main option) - electric dipole',
      awards: [
        { text: 'Deriving an expression for the electric field E due to a dipole at a point on the equatorial plane', marks: '2 1/2' },
        { text: 'Writing the expression for electric field at a far off point', marks: '1/2' },
        { text: 'Calculating the force and torque', marks: '2' },
      ],
      figure: (d, top) => dipoleFigure(d, top),
      steps: [
        { kind: 'text', text: '(a) Labelled figure showing the dipole and the equatorial point P', marks: '1/2' },
        { kind: 'text', text: 'The magnitudes of the electric fields due to the two charges +q and -q are given by' },
        { kind: 'eq', text: 'E+q = (1/4 pi e0) . q / (r^2 + a^2)', marks: '1/2' },
        { kind: 'eq', text: 'E-q = (1/4 pi e0) . q / (r^2 + a^2)' },
        {
          kind: 'text',
          text:
            'The components normal to the dipole axis cancel away. The components along the dipole axis add up. ' +
            'The total electric field is opposite to p.',
          marks: '1',
        },
        { kind: 'eq', text: 'E = -(E+q + E-q) cos(theta) p-hat' },
        { kind: 'eq', text: 'E = -(1/4 pi e0) . 2qa / (r^2 + a^2)^(3/2) . p-hat', marks: '1/2' },
        { kind: 'text', text: 'At large distance r >> a' },
        { kind: 'eq', text: 'E = -2qa / (4 pi e0 r^3) . p-hat', marks: '1/2' },
        { kind: 'text', text: '(b) Net force on the dipole' },
        { kind: 'eq', text: 'F = F+q + F-q = [ +q(2 i) - q(2 i) ]', marks: '1/2' },
        { kind: 'eq', text: 'F = 0 N', marks: '1/2' },
        { kind: 'eq', text: 'Torque t = p x E = p(-i) x 2 i', marks: '1/2' },
        { kind: 'eq', text: 't = 0', marks: '1/2' },
        {
          kind: 'note',
          text:
            'Alternatively: t = pE sin(theta). The angle between p and E is pi, hence t = 0. Award the same marks.',
        },
      ],
      total: '5',
    },
    {
      heading: 'Q31 (OR option) - cells in parallel',
      awards: [
        { text: 'Deriving the expression for equivalent e.m.f.', marks: '2' },
        { text: 'Deriving the expression for equivalent internal resistance', marks: '1' },
        { text: 'Finding the current through resistance 2R', marks: '2' },
      ],
      steps: [
        { kind: 'text', text: '(a) With I = I1 + I2 and V the common terminal potential difference' },
        { kind: 'eq', text: 'V = E1 - I1 r1  and  V = E2 - I2 r2', marks: '1/2 + 1/2' },
        { kind: 'eq', text: 'I = (E1 - V)/r1 + (E2 - V)/r2' },
        { kind: 'eq', text: 'V = (E1 r2 + E2 r1)/(r1 + r2) - I ( r1 r2 / (r1 + r2) )', marks: '1/2' },
        { kind: 'eq', text: 'Comparing with V = Eeq - I req :  Eeq = (E1 r2 + E2 r1)/(r1 + r2)', marks: '1/2' },
        { kind: 'eq', text: 'req = r1 r2 / (r1 + r2)', marks: '1' },
        { kind: 'text', text: '(b) With E1 = E, E2 = 3E and r1 = r2 = R' },
        { kind: 'eq', text: 'Eeq = (ER + 3ER)/(R + R) = 4ER/2R = 2E', marks: '1/2 + 1/2' },
        { kind: 'eq', text: 'req = R/2', marks: '1/2' },
        { kind: 'eq', text: 'I = Eeq / (2R + R/2) = 4E / 5R  A', marks: '1/2' },
      ],
      total: '5',
    },
    {
      heading: "Q32 (main option) - lens maker's formula",
      awards: [
        { text: "Deriving the expression for lens maker's formula", marks: '3' },
        { text: 'Finding the distance of the final image from the object', marks: '2' },
      ],
      figure: (d, top) => lensMakerFigure(d, top),
      steps: [
        { kind: 'text', text: '(a) Labelled ray diagram for refraction at the two surfaces of a thin lens', marks: '1' },
        { kind: 'text', text: 'The first refracting surface forms the image of the object O at I1. For refraction from the first interface ABC' },
        { kind: 'eq', text: 'n1/OB + n2/BI1 = (n2 - n1)/BC1        ...(1)', marks: '1/2' },
        {
          kind: 'text',
          text: 'Similarly for refraction from the second interface ADC, the image I1 acts as a virtual object for the second surface',
        },
        { kind: 'eq', text: '-n2/DI1 + n1/DI = (n2 - n1)/DC2        ...(2)', marks: '1/2' },
        { kind: 'text', text: 'For a thin lens BI1 = DI1. Adding equations (1) and (2)' },
        { kind: 'eq', text: 'n1/OB + n1/DI = (n2 - n1) [ 1/BC1 + 1/DC2 ]' },
        { kind: 'eq', text: '-n1/u + n1/v = (n2 - n1) [ 1/R1 - 1/R2 ]' },
        { kind: 'eq', text: '1/v - 1/u = (n2/n1 - 1) [ 1/R1 - 1/R2 ]', marks: '1/2' },
        { kind: 'text', text: 'If the object is kept at infinity the image will form at the focus, hence' },
        { kind: 'eq', text: '1/f = (n2/n1 - 1) [ 1/R1 - 1/R2 ]', marks: '1/2' },
        { kind: 'text', text: '(b) For lens L1, with u = -80 cm and f = 40 cm' },
        { kind: 'eq', text: '1/40 = 1/v1 + 1/80  gives  v1 = 80 cm', marks: '1/2' },
        { kind: 'eq', text: 'For lens L2: u2 = 120 - 80 = 40 cm, so 1/v2 = 0 and v2 = infinity', marks: '1/2' },
        { kind: 'eq', text: 'For lens L3: u3 = infinity, so v3 = 40 cm', marks: '1/2' },
        { kind: 'eq', text: 'Distance between final image and object = 80 + 120 + 20 + 40 = 260 cm', marks: '1/2' },
      ],
      total: '5',
    },
    {
      heading: 'Q32 (OR option) - concave mirror and mirror formula',
      awards: [
        { text: 'Drawing the ray diagram', marks: '1' },
        { text: 'Deriving the mirror formula', marks: '2' },
        { text: 'Calculating the focal length of the mirror', marks: '2' },
      ],
      steps: [
        { kind: 'text', text: '(a) Ray diagram for an object between F and C of a concave mirror', marks: '1' },
        { kind: 'eq', text: 'Triangles BAP and B′A′P are similar: BA/B′A′ = AP/A′P        ...(1)', marks: '1/2' },
        {
          kind: 'eq',
          text: 'Triangles MNF and B′A′F are similar, and since N is very close to P with BA = MN: BA/B′A′ = PF/A′F        ...(2)',
          marks: '1/2',
        },
        { kind: 'eq', text: 'From (1) and (2): -u/-v = -f/(-v + f)', marks: '1/2' },
        { kind: 'eq', text: '1/f = 1/v + 1/u', marks: '1/2' },
        { kind: 'note', text: 'Award full marks if the student derives the mirror formula by any other justified method.' },
        { kind: 'text', text: '(b) For a two times magnified virtual image, m = 2' },
        { kind: 'eq', text: 'm = -v/u, so v = -2u = -2(-10) = 20 cm', marks: '1/2 + 1/2' },
        { kind: 'eq', text: '1/f = 1/20 - 1/10 = (1 - 2)/20', marks: '1/2' },
        { kind: 'eq', text: 'f = -20 cm', marks: '1/2' },
      ],
      total: '5',
    },
    {
      heading: 'Q33 (main option) - Faraday’s law, self-inductance, rotating rod',
      awards: [
        { text: "Stating Faraday's law", marks: '1' },
        { text: 'Deriving the expression for self-inductance', marks: '2' },
        { text: 'Finding the induced e.m.f.', marks: '2' },
      ],
      figure: (d, top) => solenoidFigure(d, top),
      steps: [
        {
          kind: 'text',
          text:
            '(a) The magnitude of the induced e.m.f. in a circuit is equal to the time rate of change of magnetic flux ' +
            'through the circuit. Alternatively, e = -d(phi_B)/dt.',
          marks: '1',
        },
        {
          kind: 'text',
          text:
            '(b) Magnetic field due to a current carrying long solenoid of length l and area of cross section A having ' +
            'n turns per unit length is B = mu0 n I',
        },
        { kind: 'eq', text: 'Total flux linked:  N phi_B = (n l)(mu0 n I)(A) = mu0 n^2 A l I', marks: '1/2 + 1/2' },
        { kind: 'eq', text: 'L = N phi_B / I', marks: '1/2' },
        { kind: 'eq', text: 'L = mu0 n^2 A l        (equivalently L = mu0 N^2 A / l)', marks: '1/2' },
        { kind: 'note', text: 'Award full marks for any other correct alternative method.' },
        { kind: 'text', text: '(c) Induced e.m.f. of a rod pivoted at one end' },
        { kind: 'eq', text: 'e = (1/2) B l^2 omega', marks: '1/2' },
        { kind: 'eq', text: 'e = (1/2) x 4 x 10^-3 x (50 x 10^-2)^2 x (2 pi x 1)', marks: '1' },
        { kind: 'eq', text: 'e = 3.14 mV', marks: '1/2' },
        {
          kind: 'note',
          text: 'Note: 60 rpm = 1 revolution per second, so omega = 2 pi rad/s. No mark for the substitution step if this conversion is not made.',
        },
      ],
      total: '5',
    },
    {
      heading: 'Q33 (OR option) - step-up transformer',
      awards: [
        { text: 'Drawing a labelled diagram of a step-up transformer', marks: '1' },
        { text: 'Stating the principle', marks: '1/2' },
        { text: 'Obtaining the ratio of voltages in terms of number of turns and current', marks: '2' },
        { text: 'Finding (i) current in the primary coil', marks: '1/2' },
        { text: 'Finding (ii) output voltage', marks: '1' },
      ],
      steps: [
        { kind: 'text', text: '(a) Labelled diagram showing primary, secondary and soft iron core', marks: '1' },
        {
          kind: 'text',
          text:
            'Principle: when an alternating voltage is applied to the primary, the resulting current produces an ' +
            'alternating magnetic flux which links the secondary and induces an e.m.f. in it (mutual induction).',
          marks: '1/2',
        },
        { kind: 'eq', text: 'es = -Ns d(phi)/dt        ...(1)', marks: '1/2' },
        { kind: 'eq', text: 'ep = -Np d(phi)/dt        ...(2)', marks: '1/2' },
        { kind: 'eq', text: 'From (1) and (2):  vs/vp = Ns/Np', marks: '1/2' },
        { kind: 'eq', text: 'For an ideal transformer Ip Vp = Is Vs, hence Vp/Vs = Is/Ip', marks: '1/2' },
        { kind: 'text', text: '(b) With Np : Ns = 1 : 5, P = 5 kW and Vp = 200 V' },
        { kind: 'eq', text: '(i) Ip = P/Vp = 5000/200 = 25 A', marks: '1/2' },
        { kind: 'eq', text: '(ii) Vs = 5 x 200 = 1000 V', marks: '1' },
      ],
      total: '5',
    },
  ];

  for (const block of blocks) {
    ensureSpace(doc, 150);
    doc.font('serif-bold').fontSize(11).fillColor('#000');
    doc.text(block.heading, MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.4);

    // Award list, boxed the way the official scheme prints it.
    const boxTop = doc.y;
    doc.y += 7;
    for (const award of block.awards) {
      const y = doc.y;
      doc.font('serif').fontSize(10).fillColor('#111');
      doc.text(award.text, MARGIN + 12, y, { width: CONTENT_WIDTH - 74, lineGap: 2 });
      const after = doc.y;
      doc.text(award.marks, PAGE.width - MARGIN - 56, y, { width: 46, align: 'right' });
      doc.y = after;
      doc.moveDown(0.15);
    }
    doc.y += 5;
    doc
      .rect(MARGIN, boxTop, CONTENT_WIDTH, doc.y - boxTop)
      .lineWidth(0.8)
      .strokeColor('#666')
      .stroke();
    doc.moveDown(0.6);

    if (block.figure) {
      ensureSpace(doc, 130);
      doc.y += block.figure(doc, doc.y) + 10;
    }

    for (const step of block.steps) {
      if (step.kind === 'eq') {
        display(doc, step.text, step.marks);
      } else if (step.kind === 'note') {
        ensureSpace(doc, 30);
        doc.font('serif-italic').fontSize(9.5).fillColor('#555');
        doc.text(step.text, MARGIN + 12, doc.y, { width: CONTENT_WIDTH - 74, lineGap: 2 });
        doc.moveDown(0.35);
      } else {
        ensureSpace(doc, 30);
        const y = doc.y;
        doc.font('serif').fontSize(10.5).fillColor('#111');
        doc.text(step.text, MARGIN, y, { width: CONTENT_WIDTH - 74, lineGap: 2.5 });
        const after = doc.y;
        if (step.marks) {
          doc.font('serif').fontSize(9.5).fillColor('#444');
          doc.text(step.marks, PAGE.width - MARGIN - 60, y, { width: 60, align: 'right' });
        }
        doc.y = after;
        doc.moveDown(0.35);
      }
    }

    ensureSpace(doc, 26);
    doc.font('serif-bold').fontSize(10).fillColor('#000');
    doc.text(`Total: ${block.total}`, PAGE.width - MARGIN - 90, doc.y, { width: 90, align: 'right' });
    doc.moveDown(0.5);
    rule(doc, doc.y, 0.6, '#aaa');
    doc.y += 12;
  }

  ensureSpace(doc, 50);
  doc.font('serif-italic').fontSize(8.5).fillColor('#666');
  doc.text(
    'Transcribed from the official CBSE marking scheme for Physics (042), Q.P. code 55/1/1, 2026. Greek letters and ' +
      'vector notation from the original are spelled out here so the text layer stays searchable.',
    MARGIN,
    doc.y,
    { width: CONTENT_WIDTH, lineGap: 2 },
  );

  await write(doc, 'marking-scheme.pdf');
}

/* =========================== 3. student answer =========================== */

/**
 * Ruled answer sheet.
 *
 * Text is placed one ruled line at a time rather than through pdfkit's own
 * wrapping, because the lines have to sit on the rules and each one needs its
 * own small jitter. `LINE_HEIGHT` is therefore the unit of vertical layout for
 * the whole document: diagrams and gaps are measured in whole lines.
 */
const SHEET = {
  lineHeight: 21,
  firstLine: 132,
  left: 78,
  right: PAGE.width - 46,
  marginRule: 66,
  top: 108,
};
const LINES_PER_PAGE = Math.floor((PAGE.height - 60 - SHEET.firstLine) / SHEET.lineHeight);

/** Deterministic jitter, so re-running the script yields a byte-identical sheet. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

class AnswerSheet {
  private line = 0;
  private page = 1;
  private readonly random = makeRandom(20260220);

  constructor(private readonly doc: Doc, private readonly header: () => void) {
    this.drawPageFurniture();
  }

  private drawPageFurniture(): void {
    const { doc } = this;
    for (let i = 0; i < LINES_PER_PAGE; i += 1) {
      const y = SHEET.firstLine + i * SHEET.lineHeight;
      doc.moveTo(SHEET.left - 6, y).lineTo(SHEET.right, y).lineWidth(0.5).strokeColor('#c8d4e8').stroke();
    }
    doc
      .moveTo(SHEET.marginRule, SHEET.top - 34)
      .lineTo(SHEET.marginRule, SHEET.firstLine + (LINES_PER_PAGE - 1) * SHEET.lineHeight + 10)
      .lineWidth(0.8)
      .strokeColor('#e0a3a3')
      .stroke();

    if (this.page === 1) this.header();

    doc.font('serif').fontSize(8).fillColor('#8a8a8a');
    doc.text(`Page ${this.page}`, PAGE.width - MARGIN - 60, PAGE.height - 46, { width: 60, align: 'right' });
  }

  /** y coordinate of the baseline currently being written on. */
  private baselineY(): number {
    return SHEET.firstLine + this.line * SHEET.lineHeight - 5;
  }

  private advance(lines = 1): void {
    this.line += lines;
    if (this.line >= LINES_PER_PAGE) {
      this.doc.addPage();
      this.page += 1;
      this.line = 0;
      this.drawPageFurniture();
    }
  }

  /** Reserves `lines` ruled lines and returns the top y of the reserved band. */
  reserve(lines: number): number {
    if (this.line + lines >= LINES_PER_PAGE) {
      this.doc.addPage();
      this.page += 1;
      this.line = 0;
      this.drawPageFurniture();
    }
    const top = SHEET.firstLine + this.line * SHEET.lineHeight - SHEET.lineHeight + 4;
    this.line += lines;
    return top;
  }

  blank(lines = 1): void {
    this.advance(lines);
  }

  /**
   * Writes one logical line, wrapping by hand at the right edge. Continuation
   * lines are indented so a wrapped equation still reads as one statement.
   */
  text(
    content: string,
    opts: { indent?: number; size?: number; colour?: string; underline?: boolean; strike?: boolean } = {},
  ): void {
    const { doc } = this;
    const size = opts.size ?? 12.5;
    const indent = opts.indent ?? 0;
    const colour = opts.colour ?? '#1a2b4a';
    const maxWidth = SHEET.right - SHEET.left - indent - 10;

    doc.font('hand').fontSize(size);
    const words = content.split(' ');
    const rows: string[] = [];
    let row = '';
    for (const word of words) {
      const candidate = row ? `${row} ${word}` : word;
      if (doc.widthOfString(candidate) > maxWidth && row) {
        rows.push(row);
        row = word;
      } else {
        row = candidate;
      }
    }
    if (row) rows.push(row);

    rows.forEach((rowText, i) => {
      const jitterX = (this.random() - 0.5) * 2.2;
      const jitterY = (this.random() - 0.5) * 1.8;
      const x = SHEET.left + indent + (i > 0 ? 18 : 0) + jitterX;
      const y = this.baselineY() + jitterY;
      doc.font('hand').fontSize(size + (this.random() - 0.5) * 0.4).fillColor(colour);
      doc.text(rowText, x, y, { lineBreak: false });
      const width = doc.widthOfString(rowText);
      if (opts.underline) {
        doc.moveTo(x, y + size + 1).lineTo(x + width, y + size + 1).lineWidth(0.8).strokeColor(colour).stroke();
      }
      if (opts.strike) {
        doc.moveTo(x - 1, y + size * 0.55).lineTo(x + width + 1, y + size * 0.55).lineWidth(1).strokeColor(colour).stroke();
      }
      this.advance();
    });
  }

  /** A heading such as "Q31." written a little larger and underlined. */
  heading(content: string): void {
    if (this.line > LINES_PER_PAGE - 4) this.advance(LINES_PER_PAGE - this.line);
    this.text(content, { size: 14, underline: true, colour: '#16233d' });
  }
}

async function buildStudentAnswer(): Promise<void> {
  const doc = newDoc('CBSE 2026 Physics 55/1/1 - candidate answer script', 'Student answer', 0);

  const header = () => {
    doc.font('serif-bold').fontSize(11).fillColor('#333');
    doc.text('ANSWER BOOK', MARGIN, 46, { width: CONTENT_WIDTH, align: 'center' });
    doc.font('serif').fontSize(9).fillColor('#555');
    doc.text('Physics (042)  -  Class XII Board Examination 2026  -  Q.P. Code 55/1/1', MARGIN, 62, {
      width: CONTENT_WIDTH,
      align: 'center',
    });
    rule(doc, 78, 0.6, '#bbb');
    doc.font('hand').fontSize(11).fillColor('#1a2b4a');
    doc.text('Name: Ananya Sharma', MARGIN + 8, 86, { lineBreak: false });
    doc.text('Roll No: 7261084', MARGIN + 210, 86, { lineBreak: false });
    doc.text('Section E only', MARGIN + 370, 86, { lineBreak: false });
  };

  const sheet = new AnswerSheet(doc, header);

  /* ------------------------------- Q31 ---------------------------------- */
  sheet.heading('Q31. (a)');
  const dipoleTop = sheet.reserve(7);
  dipoleFigure(doc, dipoleTop, 'hand');
  sheet.blank();
  sheet.text('The dipole has charges +q and -q separated by 2a. P is a point on the');
  sheet.text('equatorial plane at a distance r from the centre O.');
  sheet.text('Distance of P from each charge = sqrt(r^2 + a^2)');
  sheet.text('E+q = (1/4 pi e0) . q/(r^2 + a^2)   , along the line from +q to P', { indent: 14 });
  sheet.text('E-q = (1/4 pi e0) . q/(r^2 + a^2)   , along the line from P to -q', { indent: 14 });
  sheet.text('Both are equal in magnitude.');
  sheet.text('The components perpendicular to the axis cancel out and the components');
  sheet.text('parallel to the axis add up.');
  sheet.text('So E = (E+q + E-q) cos(theta)   where cos(theta) = a / sqrt(r^2 + a^2)', { indent: 14 });
  sheet.text('E = 2 x (1/4 pi e0) x q/(r^2 + a^2) x a/sqrt(r^2 + a^2)', { indent: 14 });
  sheet.text('E = (1/4 pi e0) . 2qa / (r^2 + a^2)^(3/2)', { indent: 14, underline: true });
  sheet.text('For a far off point r >> a, so (r^2 + a^2)^(3/2) is nearly r^3');
  sheet.text('E = (1/4 pi e0) . 2qa/r^3 = p / (4 pi e0 r^3)', { indent: 14, underline: true });
  sheet.blank();

  sheet.heading('(b)');
  sheet.text('Charge +q is at x = a and charge -q is at x = b, and E = 2 i N/C.');
  sheet.text('Force on +q = qE = 2q i', { indent: 14 });
  sheet.text('Force on -q = -qE = -2q i', { indent: 14 });
  sheet.text('Net force F = 2q i - 2q i = 0 N', { indent: 14, underline: true });
  sheet.text('(the field is uniform so the two forces are equal and opposite)');
  sheet.text('Torque, t = p E sin(theta)');
  sheet.text('The dipole is placed in the x-y plane and E is along x, so I take the');
  sheet.text('angle between p and E as theta = 90 degrees.');
  sheet.text('p = q x (b - a)', { indent: 14 });
  sheet.text('t = q(b - a) x 2 x sin 90 = 2q(b - a) N m', { indent: 14, underline: true });
  sheet.blank(2);

  /* ------------------------------- Q32 ---------------------------------- */
  sheet.heading('Q32. (a) Lens maker’s formula');
  const lensTop = sheet.reserve(6);
  lensMakerFigure(doc, lensTop, 'hand');
  sheet.blank();
  sheet.text('Let a thin lens of refractive index n2 be kept in a medium of refractive');
  sheet.text('index n1. The two surfaces have radii of curvature R1 and R2.');
  sheet.text('The first surface ABC forms the image of the object O at I1.');
  sheet.text('n1/OB + n2/BI1 = (n2 - n1)/BC1        ...(1)', { indent: 14 });
  sheet.text('For the second surface ADC, I1 acts as a virtual object and the final');
  sheet.text('image is formed at I.');
  sheet.text('-n2/DI1 + n1/DI = (n2 - n1)/DC2        ...(2)', { indent: 14 });
  sheet.text('For a thin lens BI1 = DI1.');
  sheet.text('Adding (1) and (2),');
  sheet.text('n1/OB + n1/DI = (n2 - n1) [ 1/BC1 + 1/DC2 ]', { indent: 14 });
  sheet.text('-n1/u + n1/v = (n2 - n1) [ 1/R1 - 1/R2 ]', { indent: 14 });
  sheet.text('1/v - 1/u = (n2/n1 - 1) [ 1/R1 - 1/R2 ]', { indent: 14 });
  sheet.text('So 1/f = (n2/n1 - 1) [ 1/R1 - 1/R2 ]', { indent: 14, underline: true });
  sheet.text('which is the lens maker’s formula.');
  sheet.blank();

  sheet.heading('(b)');
  const threeLensTop = sheet.reserve(5);
  threeLensFigure(doc, threeLensTop, 'hand');
  sheet.blank();
  sheet.text('f1 = f2 = f3 = 40 cm and u1 = -80 cm');
  sheet.text('For L1 :  1/v1 - 1/(-80) = 1/40', { indent: 14 });
  sheet.text('1/v1 = 1/40 - 1/80 = 1/80', { indent: 32 });
  sheet.text('v1 = 80 cm   (to the right of L1)', { indent: 32 });
  sheet.text('For L2 :  L1 L2 = 120 cm, so u2 = -(120 - 80) = -40 cm', { indent: 14 });
  sheet.text('1/v2 = 1/40 + 1/(-40) = 0', { indent: 32 });
  sheet.text('v2 = infinity   (parallel beam leaves L2)', { indent: 32 });
  sheet.text('For L3 :  u3 = infinity', { indent: 14 });
  sheet.text('1/v3 = 1/40, so v3 = 40 cm', { indent: 32 });
  sheet.text('The final image is 40 cm to the right of L3.');
  sheet.text('Distance of final image from the object = 120 + 20 + 40', { indent: 14 });
  sheet.text('= 180 cm', { indent: 130, underline: true });
  sheet.blank(2);

  /* ------------------------------- Q33 ---------------------------------- */
  sheet.heading('Q33. (a)');
  sheet.text('Faraday’s law : whenever the magnetic flux linked with a closed circuit');
  sheet.text('changes, an e.m.f. is induced in it. The magnitude of the induced e.m.f.');
  sheet.text('is equal to the rate of change of magnetic flux linked with the circuit.');
  sheet.text('e = - d(phi_B)/dt', { indent: 14, underline: true });
  sheet.blank();

  sheet.heading('(b)');
  const solenoidTop = sheet.reserve(5);
  solenoidFigure(doc, solenoidTop, 'hand');
  sheet.text('Let the solenoid have length l, area of cross section A and N turns, so');
  sheet.text('the number of turns per unit length is n = N/l.');
  sheet.text('Magnetic field inside a long solenoid, B = mu0 n I', { indent: 14 });
  sheet.text('Flux through one turn = B A = mu0 n I A', { indent: 14 });
  sheet.text('Total flux linked, N phi_B = (n l)(mu0 n I)(A) = mu0 n^2 A l I', { indent: 14 });
  sheet.text('Self inductance L = N phi_B / I', { indent: 14 });
  sheet.text('L = mu0 n^2 A l = mu0 N^2 A / l', { indent: 14, underline: true });
  sheet.blank();

  sheet.heading('(c)');
  const rodTop = sheet.reserve(6);
  rotatingRodFigure(doc, rodTop, 'hand');
  sheet.text('l = 50 cm = 0.5 m,   B = 4.0 mT = 4 x 10^-3 T');
  sheet.text('omega = 60 rpm = 60 rad/s', { indent: 14 });
  sheet.text('For a rod pivoted at one end,');
  sheet.text('e = (1/2) B l^2 omega', { indent: 14 });
  sheet.text('= (1/2) x 4 x 10^-3 x (0.5)^2 x 60', { indent: 32 });
  sheet.text('= (1/2) x 4 x 10^-3 x 0.25 x 60', { indent: 32 });
  sheet.text('= 0.03 V = 30 mV', { indent: 32, underline: true });

  await write(doc, 'student-answer.pdf');
}

/* ================================= main ================================== */

async function main(): Promise<void> {
  for (const [name, file] of Object.entries(FONTS)) {
    if (!fs.existsSync(file)) throw new Error(`Missing font for "${name}": ${file}`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await buildQuestionPaper();
  await buildMarkingScheme();
  await buildStudentAnswer();
  for (const file of fs.readdirSync(OUT_DIR).sort()) {
    const { size } = fs.statSync(path.join(OUT_DIR, file));
    console.log(`recording_sample/${file}  ${(size / 1024).toFixed(1)} kB`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
