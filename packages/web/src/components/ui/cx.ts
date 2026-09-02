/**
 * Class name joiner.
 *
 * The old code built class strings with nested template literals
 * (`` `criterion ${tone}${active ? ' active' : ''}` ``), which is where several
 * of the double-space and missing-space bugs came from.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
