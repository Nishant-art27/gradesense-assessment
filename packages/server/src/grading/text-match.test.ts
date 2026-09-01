import { describe, expect, it } from 'vitest';
import { findPhrase, ocrFold, sentenceAround, tokenSimilarity, windowAround } from './text-match.js';

/**
 * The matcher has to do two opposing things at once: forgive a bad scan, and
 * refuse a phrase whose meaning has been inverted by a single word. Getting one
 * without the other is easy; these tests pin down both.
 */

describe('OCR folding', () => {
  it('collapses the confusions it covers to identical strings', () => {
    // m read as rn, and the i / l / 1 / I family.
    expect(ocrFold('dernand')).toBe(ocrFold('demand'));
    expect(ocrFold('rny')).toBe(ocrFold('my'));
    expect(ocrFold('vo1tmeter')).toBe(ocrFold('voltmeter'));
    expect(ocrFold('paraliel')).toBe(ocrFold('parallel'));
    expect(ocrFold('quantlty')).toBe(ocrFold('quantity'));
  });

  /*
   * Folding is not meant to cover every confusion. "currenl" for "current" is a
   * t/l swap, which folding deliberately leaves alone — collapsing t into the
   * i/l family would start matching genuinely different words. Those cases are
   * caught by edit distance instead, which is why the two mechanisms coexist.
   */
  it('leaves confusions outside its table to edit distance', () => {
    expect(ocrFold('currenl')).not.toBe(ocrFold('current'));
    expect(tokenSimilarity('currenl', 'current')).toBeGreaterThan(0.7);
    expect(tokenSimilarity('circuil', 'circuit')).toBeGreaterThan(0.7);
  });

  it('does not collapse words that merely look similar', () => {
    expect(ocrFold('left')).not.toBe(ocrFold('right'));
    expect(ocrFold('ammeter')).not.toBe(ocrFold('voltmeter'));
    expect(ocrFold('shortage')).not.toBe(ocrFold('surplus'));
    expect(ocrFold('series')).not.toBe(ocrFold('parallel'));
  });
});

describe('token similarity', () => {
  it('rates OCR-damaged words as near-identical', () => {
    expect(tokenSimilarity('arnmeter', 'ammeter')).toBeGreaterThan(0.7);
    expect(tokenSimilarity('ballery', 'battery')).toBeGreaterThan(0.7);
    expect(tokenSimilarity('resistarice', 'resistance')).toBeGreaterThan(0.7);
    expect(tokenSimilarity('equiIibriurn', 'equilibrium')).toBeGreaterThan(0.7);
  });

  it('rates a substituted content word as clearly different', () => {
    expect(tokenSimilarity('voltmeter', 'ammeter')).toBeLessThan(0.7);
    expect(tokenSimilarity('right', 'left')).toBeLessThan(0.7);
  });
});

describe('finding a phrase', () => {
  const answer =
    'The battery, switch, resistor, bulb and ammeter are all connected in series in the main circuit. ' +
    'The voltmeter is connected in parallel across the bulb, because it measures potential difference.';

  it('matches exactly, ignoring punctuation and spacing differences', () => {
    const match = findPhrase(answer, 'voltmeter is connected in  parallel across the bulb!');
    expect(match).not.toBeNull();
    expect(match!.exact).toBe(true);
    expect(match!.similarity).toBe(1);
    expect(answer.slice(match!.start, match!.end)).toContain('parallel across the bulb');
  });

  it('matches through OCR damage', () => {
    const scanned =
      'The ballery, switch, resistor, bulb and arnmeter are all connected in series in the main circuil.';
    const match = findPhrase(scanned, 'connected in series in the main circuit');

    expect(match).not.toBeNull();
    expect(match!.exact).toBe(false);
    expect(match!.similarity).toBeGreaterThan(0.8);
  });

  /*
   * The two cases that motivated the per-token floor. Both phrases differ from
   * the text by one word out of seven or nine, so a mean-only comparison scored
   * them above 0.88 and matched — which made the grader mark a correct answer
   * wrong. Meaning does not average out.
   */
  it('refuses a phrase whose meaning is inverted by one word', () => {
    expect(findPhrase(answer, 'ammeter is connected in parallel across the bulb')).toBeNull();

    const shift = 'Therefore the supply curve will shift towards the left side.';
    expect(findPhrase(shift, 'the supply curve shifts to the right')).toBeNull();
    expect(findPhrase(shift, 'the supply curve will shift towards the left')).not.toBeNull();
  });

  it('returns null when the phrase simply is not there', () => {
    expect(findPhrase(answer, 'a beautifully reasoned paragraph about quantum tunnelling')).toBeNull();
  });
});

describe('quote framing', () => {
  const text = 'First sentence here. The second one has the circut misspelling in it. A third follows.';

  it('expands a match to its containing sentence', () => {
    const index = text.indexOf('circut');
    const sentence = sentenceAround(text, index, index + 6);

    expect(sentence).toBe('The second one has the circut misspelling in it.');
  });

  it('quotes a few words around a single misspelling', () => {
    const index = text.indexOf('circut');
    const window = windowAround(text, index, index + 6, 3);

    expect(window).toContain('circut');
    expect(window.length).toBeLessThan(text.length);
  });

  it('does not let a window cross a line break', () => {
    const wrapped = 'the source which\ngives the potencial difference to the circuit';
    const index = wrapped.indexOf('potencial');
    const window = windowAround(wrapped, index, index + 9, 6);

    expect(window).not.toContain('\n');
    expect(window).toContain('potencial');
  });
});
