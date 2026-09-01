import { useCountUp } from '../hooks/useCountUp.js';

/**
 * The score, with confidence drawn as a ring around it.
 *
 * The two numbers belong together: a score means something different at 92%
 * confidence than at 61%, and putting the confidence in a separate widget
 * invites people to read the mark and ignore the caveat. The ring is coloured by
 * band so the distinction is legible before anyone reads a digit.
 */
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
  const shownConfidence = useCountUp(Math.round(confidence * 100), 900, 0);

  const band = confidence >= 0.8 ? 'high' : confidence >= 0.65 ? 'medium' : 'low';
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const filled = circumference * Math.min(1, Math.max(0, confidence));

  return (
    <div className="score-dial">
      <svg viewBox="0 0 128 128" className={`dial band-${band}`}>
        <circle className="dial-track" cx="64" cy="64" r={radius} />
        <circle
          className="dial-value"
          cx="64"
          cy="64"
          r={radius}
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference - filled}
        />
      </svg>

      <div className="dial-centre">
        <div className="dial-score">
          <span className="dial-total">{formatMark(shownTotal)}</span>
          <span className="dial-max">/{max}</span>
        </div>
        <div className={`dial-conf band-${band}`}>{Math.round(shownConfidence)}% confident</div>
      </div>
    </div>
  );
}

/** Keeps 7.5 as "7.5" and 15 as "15" rather than "15.0". */
function formatMark(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
