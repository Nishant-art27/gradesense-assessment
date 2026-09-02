import { FINDING_KINDS, type FindingKind } from './model-output.js';

/**
 * The one place an annotation colour is decided.
 *
 * A red box on screen must be the same red in the exported PDF, or the numbering
 * stops making sense across the two documents a teacher is holding. That used to
 * be a comment asking three copies of this table to stay in step — the web
 * tokens, a second darker set for boxes drawn over white paper, and a set of
 * 0..1 floats in the export. They had already drifted apart by a shade.
 *
 * So there is one table, and both sides derive from it: the web stylesheet reads
 * the hex, `export/annotate.ts` reads `paletteRgb01()`.
 *
 * The values are chosen to stay legible over black text on white paper, which is
 * also what the interface is now, so a single set covers both.
 */
export const ANNOTATION_COLOURS: Record<FindingKind, string> = {
  incorrect: '#D62E33',
  missing: '#DB7A05',
  spelling: '#1668C4',
  grammar: '#4F4ECC',
  layout: '#8B45BD',
  praise: '#0F8F56',
};

/** Display label per kind, shared with the export's marking summary. */
export const ANNOTATION_LABELS: Record<FindingKind, string> = {
  incorrect: 'Incorrect',
  missing: 'Missing',
  spelling: 'Spelling',
  grammar: 'Grammar',
  layout: 'Layout',
  praise: 'Good',
};

export interface Rgb01 {
  r: number;
  g: number;
  b: number;
}

/** `#RRGGBB` to the 0..1 channel triple pdf-lib's `rgb()` expects. */
export function hexToRgb01(hex: string): Rgb01 {
  const value = hex.replace('#', '');
  return {
    r: Number.parseInt(value.slice(0, 2), 16) / 255,
    g: Number.parseInt(value.slice(2, 4), 16) / 255,
    b: Number.parseInt(value.slice(4, 6), 16) / 255,
  };
}

/** The palette in the form the PDF export needs. */
export function paletteRgb01(): Record<FindingKind, Rgb01> {
  return Object.fromEntries(
    FINDING_KINDS.map((kind) => [kind, hexToRgb01(ANNOTATION_COLOURS[kind])]),
  ) as Record<FindingKind, Rgb01>;
}
