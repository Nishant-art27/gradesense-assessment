/**
 * Reading a model's JSON back, defensively.
 *
 * Every provider here asks for schema-constrained output, which should make a
 * parse failure impossible. "Should" is not a guarantee across three vendors and
 * their model updates, so a model that wraps its JSON in prose is recovered from
 * rather than treated as an outage — and one that returns something genuinely
 * unusable returns `null`, which the repair retry in the pipeline then handles.
 *
 * Shared rather than copied per provider: this is a property of the contract,
 * not of any one vendor, and three copies would drift.
 */
export function safeJsonParse(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to salvaging the outermost object.
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first < 0 || last <= first) return null;

  try {
    return JSON.parse(trimmed.slice(first, last + 1));
  } catch {
    return null;
  }
}
