import { useEffect, useRef, useState } from 'react';

/**
 * Animates a number up to its target.
 *
 * Used for the score and the confidence figure. Driven by rAF with an ease-out
 * curve rather than a CSS transition, because the value itself is text and has
 * to be re-rendered on each frame.
 *
 * Respects `prefers-reduced-motion`: if the viewer has asked for less movement,
 * the final value appears immediately instead of counting.
 */
export function useCountUp(target: number, durationMs = 900, decimals = 1): number {
  const [value, setValue] = useState(target);
  const frame = useRef<number>(0);
  const from = useRef(target);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setValue(target);
      return;
    }

    const start = performance.now();
    const origin = from.current;
    const delta = target - origin;

    if (delta === 0) {
      setValue(target);
      return;
    }

    const step = (now: number) => {
      const elapsed = Math.min(1, (now - start) / durationMs);
      // easeOutCubic — fast first, settles gently on the final figure.
      const eased = 1 - Math.pow(1 - elapsed, 3);
      const next = origin + delta * eased;
      setValue(Number(next.toFixed(decimals)));
      if (elapsed < 1) {
        frame.current = requestAnimationFrame(step);
      } else {
        setValue(target);
        from.current = target;
      }
    };

    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [target, durationMs, decimals]);

  return value;
}
