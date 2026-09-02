import { useCountUp } from '../hooks/useCountUp.js';

/**
 * The score, with confidence drawn as a second ring inside it.
 *
 * The two belong together: a score means something different at 92% confidence
 * than at 61%, and putting the confidence in a separate widget invites people to
 * read the mark and ignore the caveat. So the outer ring is the mark, the thin
 * inner arc is how much of it was actually verified, and the whole dial takes the
 * confidence band's colour — the caveat is unmissable before anyone reads a digit.
 *
 * The percentage itself is spelled out beside the dial rather than inside it.
 * "73% confident" does not fit within the inner arc at any size this panel can
 * spare, and shrinking it to "73%" next to a "7.5/15" only invites the two
 * numbers to be confused.
 */

const OUTER_R = 44;
const INNER_R = 33;

export function ScoreDial({
  total,
  max,
  confidence,
}: {
  total: number;
  max: number;
  confidence: number;
}) {
  const shownTotal = useCountUp(total, 900, total % 1 === 0 ? 0 : 1);
  const marks = max > 0 ? clamp01(total / max) : 0;

  return (
    <div className={`dial band-${bandFor(confidence)}`}>
      <svg viewBox="0 0 104 104" aria-hidden="true">
        <circle className="dial__track" cx="52" cy="52" r={OUTER_R} strokeWidth={8} />
        <Arc className="dial__marks" radius={OUTER_R} fraction={marks} />
        <Arc className="dial__conf" radius={INNER_R} fraction={clamp01(confidence)} />
      </svg>

      <div className="dial__centre">
        <div className="dial__score">
          <span className="dial__total">{formatMark(shownTotal)}</span>
          <span className="dial__max">/{max}</span>
        </div>
      </div>
    </div>
  );
}

/** The confidence figure that belongs beside the dial, in the same band colour. */
export function ConfidenceReading({ confidence }: { confidence: number }) {
  const shown = useCountUp(Math.round(confidence * 100), 900, 0);
  return (
    <span className={`confidence band-${bandFor(confidence)}`}>
      {Math.round(shown)}% confident
    </span>
  );
}

/** Shared by the dial and the reading, so they can never disagree. */
function bandFor(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.65) return 'medium';
  return 'low';
}

function Arc({
  className,
  radius,
  fraction,
}: {
  className: string;
  radius: number;
  fraction: number;
}) {
  const circumference = 2 * Math.PI * radius;
  return (
    <circle
      className={className}
      cx="52"
      cy="52"
      r={radius}
      strokeDasharray={`${circumference} ${circumference}`}
      strokeDashoffset={circumference * (1 - fraction)}
    />
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 7.5 stays 7.5; 15 does not become 15.0. */
function formatMark(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
