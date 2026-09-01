/**
 * Fuzzy text matching shared by annotation anchoring and the mock grader.
 *
 * Both need to answer the same question — "does this phrase appear in the
 * student's answer, allowing for a bad scan?" — so the similarity primitives
 * live here rather than being written twice.
 */

/** Levenshtein distance, single rolling row. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = current[j - 1]! + 1;
      const deletion = previous[j]! + 1;
      current.push(Math.min(substitution, insertion, deletion));
    }
    previous = current;
  }

  return previous[b.length]!;
}

/**
 * Folds the character confusions a bad scan actually produces, so that OCR
 * damage costs nothing while a genuinely different word still reads as
 * different.
 *
 * Without this the two failure modes are impossible to separate: raising the
 * similarity bar high enough to reject "voltmeter" for "ammeter" also rejects
 * "arnmeter", and lowering it enough to accept "arnmeter" also accepts
 * "voltmeter". Folding removes the noise first, so the bar only has to judge
 * meaning.
 */
export function ocrFold(text: string): string {
  return (
    text
      // "m" is very commonly split into "rn" by an optical reader.
      .replace(/rn/g, 'm')
      // i / l / 1 / I / | are mutually confusable; collapse them to one symbol.
      .replace(/[il1|]/g, 'i')
      .replace(/0/g, 'o')
      .replace(/5/g, 's')
  );
}

export function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const foldedA = ocrFold(a);
  const foldedB = ocrFold(b);
  const longest = Math.max(foldedA.length, foldedB.length);
  if (longest === 0) return 1;
  return 1 - editDistance(foldedA, foldedB) / longest;
}

/**
 * No single token in a window may fall below this.
 *
 * A mean alone is not enough: "the supply curve shifts to the right" and
 * "…to the left" differ in one word out of seven and still average 0.89, which
 * is exactly the substitution that flips the meaning. Requiring every token to
 * clear a floor catches those, while OCR folding keeps scanned text above it.
 */
const MIN_TOKEN_SIMILARITY = 0.68;

export interface Normalised {
  /** Lower-cased, punctuation-stripped, whitespace-collapsed text. */
  norm: string;
  /** `map[i]` is the offset in the source text that produced `norm[i]`. */
  map: number[];
}

/**
 * Collapses a string to a comparable form while remembering where each
 * surviving character came from, so a match can be mapped back to the original
 * text — and from there to rectangles on the page.
 *
 * Punctuation is dropped rather than replaced with a space: differing quotation
 * marks or a stray comma should not prevent a match. Note the consequence that
 * "V = IR" and "V = I/R" normalise identically, so anything that turns on
 * punctuation must be matched with a raw regex instead.
 */
export function normalise(text: string): Normalised {
  const norm: string[] = [];
  const map: number[] = [];
  let lastWasSpace = true;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        norm.push(' ');
        map.push(i);
        lastWasSpace = true;
      }
      continue;
    }
    if (/[\p{L}\p{N}]/u.test(ch)) {
      norm.push(ch.toLowerCase());
      map.push(i);
      lastWasSpace = false;
    }
  }

  while (norm.length > 0 && norm[norm.length - 1] === ' ') {
    norm.pop();
    map.pop();
  }

  return { norm: norm.join(''), map };
}

export interface Token {
  text: string;
  start: number;
  end: number;
}

export function tokenise(norm: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /[^\s]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(norm)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/**
 * Similarity between a phrase and a window of text tokens.
 *
 * Token-by-token comparison is what makes OCR damage cheap to see through: it
 * keeps a corrupted word's error local instead of knocking the whole window's
 * character alignment out of step, which is what a raw character-level
 * comparison would do.
 *
 * Returns 0 as soon as any token falls below the floor, so one substituted
 * content word disqualifies the window no matter how well the rest lines up.
 */
export function windowSimilarity(phraseTokens: Token[], textTokens: Token[], offset: number): number {
  let total = 0;
  for (let i = 0; i < phraseTokens.length; i += 1) {
    const textToken = textTokens[offset + i];
    if (!textToken) return 0;
    const similarity = tokenSimilarity(phraseTokens[i]!.text, textToken.text);
    if (similarity < MIN_TOKEN_SIMILARITY) return 0;
    total += similarity;
  }
  return total / phraseTokens.length;
}

export interface PhraseMatch {
  /** Offsets into the original (un-normalised) text. */
  start: number;
  end: number;
  similarity: number;
  exact: boolean;
  /** The matched span, verbatim from the source text. */
  text: string;
}

/**
 * Finds `phrase` in `text`, exactly if possible and fuzzily otherwise.
 * Returns null when nothing clears `threshold`.
 */
export function findPhrase(text: string, phrase: string, threshold = 0.8): PhraseMatch | null {
  const haystack = normalise(text);
  const needle = normalise(phrase);
  if (needle.norm.length === 0 || haystack.norm.length === 0) return null;

  const exactIndex = haystack.norm.indexOf(needle.norm);
  if (exactIndex >= 0) {
    const start = haystack.map[exactIndex]!;
    const end = haystack.map[exactIndex + needle.norm.length - 1]! + 1;
    return { start, end, similarity: 1, exact: true, text: text.slice(start, end) };
  }

  const textTokens = tokenise(haystack.norm);
  const phraseTokens = tokenise(needle.norm);
  if (phraseTokens.length === 0 || textTokens.length < phraseTokens.length) return null;

  let best: { offset: number; similarity: number } | null = null;
  const lastOffset = textTokens.length - phraseTokens.length;
  for (let offset = 0; offset <= lastOffset; offset += 1) {
    const similarity = windowSimilarity(phraseTokens, textTokens, offset);
    if (!best || similarity > best.similarity) best = { offset, similarity };
    if (similarity === 1) break;
  }

  if (!best || best.similarity < threshold) return null;

  const firstToken = textTokens[best.offset]!;
  const lastToken = textTokens[best.offset + phraseTokens.length - 1]!;
  const start = haystack.map[firstToken.start]!;
  const end = haystack.map[lastToken.end - 1]! + 1;

  return {
    start,
    end,
    similarity: Number(best.similarity.toFixed(4)),
    exact: false,
    text: text.slice(start, end),
  };
}

/**
 * Expands a match to the sentence containing it.
 *
 * Evidence quotes read better, and anchor more reliably, as a whole clause than
 * as a bare fragment — and a longer span is less likely to be ambiguous.
 */
export function sentenceAround(text: string, start: number, end: number): string {
  const boundary = /[.!?\n]/;

  let from = start;
  while (from > 0 && !boundary.test(text[from - 1]!)) from -= 1;

  let to = end;
  while (to < text.length && !boundary.test(text[to]!)) to += 1;
  if (to < text.length) to += 1; // include the terminator

  return text.slice(from, to).trim();
}

/**
 * A short window of words around a match, for quoting a single misspelled word.
 *
 * A bare six-letter word is too generic to anchor safely, so spelling findings
 * quote their surroundings instead. The window stops at line breaks: a quote
 * that crosses one produces boxes on two lines, and for a single misspelling
 * that looks like a mistake rather than a mark-up.
 */
export function windowAround(text: string, start: number, end: number, words = 4): string {
  let from = start;
  let seen = 0;
  while (from > 0 && seen < words) {
    if (text[from - 1] === '\n') break;
    from -= 1;
    if (/\s/.test(text[from]!)) seen += 1;
  }

  let to = end;
  seen = 0;
  while (to < text.length && seen < words) {
    if (text[to] === '\n') break;
    if (/\s/.test(text[to]!)) seen += 1;
    to += 1;
  }

  return text.slice(from, to).trim();
}
