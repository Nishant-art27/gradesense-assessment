/**
 * The GradeSense mark: a "G." built from primitives rather than a traced blob.
 *
 * Geometry, in the viewBox's own units — a circle of radius 100 centred on the
 * origin, cut by a horizontal line 10.5 above centre so the top reads flat:
 *
 *   bowl      the kept lower portion of that circle, with a concentric r=53
 *             circle removed, leaving a thick arc
 *   crossbar  a block over the upper-right of the counter, which is what turns
 *             a "C" into a "G"; its lower edge is the G's bar
 *   dot       r=19, its baseline flush with the bottom of the bowl
 *
 * Two details that are easy to get wrong and were:
 *
 *   Both arcs sweep more than 180° (192° and 203°), so large-arc-flag must be 1.
 *   With 0 the renderer takes the short way round and the counter is never
 *   subtracted, which reads as a solid bowl.
 *
 *   The crossbar reaches x=70, well inside the ring, rather than stopping at the
 *   counter's edge (~52) or running to the outer edge (100). Coincident with the
 *   inner arc it leaves an antialiasing seam; past the outer arc it protrudes.
 *
 * Drawn with `currentColor` and no intrinsic size, so one component serves the
 * header and any other use at any scale.
 */
export function Logo({ title }: { title?: string }) {
  return (
    <svg
      className="logo"
      viewBox="-100 -11 240 112"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <path
        d="M -99.45 -10.5 A 100 100 0 1 0 99.45 -10.5
           L 51.95 -10.5 A 53 53 0 1 1 -51.95 -10.5 Z"
        fill="currentColor"
      />
      <rect x="-13" y="-10.5" width="83" height="40.5" fill="currentColor" />
      <circle cx="119" cy="81" r="19" fill="currentColor" />
    </svg>
  );
}
