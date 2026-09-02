/**
 * Line icons, 24×24, 1.5px stroke, inheriting `currentColor`.
 *
 * Drawn here rather than pulled from a library so the set stays small and every
 * glyph actually depicts the thing it labels — the reference uses spare
 * single-purpose line icons, not a generic pictogram grab-bag.
 */

const BOX = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/** A value pinned to a ceiling — marks clamped to the maximum. */
export function IconCeiling() {
  return (
    <svg {...BOX}>
      <path d="M4 6h16" />
      <path d="M12 20V10" />
      <path d="M8 13l4-4 4 4" />
    </svg>
  );
}

/** A sum — the total recomputed rather than taken on trust. */
export function IconSum() {
  return (
    <svg {...BOX}>
      <path d="M17 5H7l6 7-6 7h10" />
    </svg>
  );
}

/** Quotation marks — every judgement cites the student. */
export function IconQuote() {
  return (
    <svg {...BOX}>
      <path d="M9 7c-2.2 0-4 1.8-4 4s1.8 4 4 4c0 2-1 3-3 3" />
      <path d="M19 7c-2.2 0-4 1.8-4 4s1.8 4 4 4c0 2-1 3-3 3" />
    </svg>
  );
}

/** A sealed document — the original is never modified. */
export function IconSealed() {
  return (
    <svg {...BOX}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <circle cx="12" cy="14" r="2.5" />
      <path d="M12 16.5V19" />
    </svg>
  );
}

/** Close. */
export function IconClose() {
  return (
    <svg {...BOX}>
      <path d="M7 7l10 10M17 7L7 17" />
    </svg>
  );
}
