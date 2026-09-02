import { describe, expect, it } from 'vitest';
import { estimateTokens, maxPromptTokens, planRequest, variableAllowance, type TokenBudget } from './tokens.js';

/**
 * The estimator has one job: never say a request fits when the provider will
 * say it does not. So the tests pin down that it errs high on ordinary prose,
 * grows with the text, and that the plan leaves the reserved completion and
 * the safety margin untouched.
 */

const GROQ_FREE: TokenBudget = { requestLimit: 8_000, completionReserve: 3_000, safetyMargin: 0.08 };

describe('estimateTokens', () => {
  it('returns zero for nothing', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('over-counts prose rather than under-counting it', () => {
    // 100 words of plain English is about 130 real tokens.
    const prose = Array.from({ length: 100 }, (_, i) => `word${i % 7}`).join(' ');
    expect(estimateTokens(prose)).toBeGreaterThanOrEqual(130);
  });

  it('charges more for symbol-heavy maths than for the same length of prose', () => {
    const prose = 'the electric field at a point on the equatorial line of the dipole';
    const maths = 'E = -(1/4πε₀)·(2qa)/(r²+a²)^(3/2) p̂ ; τ = p × E = 0';
    expect(estimateTokens(maths) / maths.length).toBeGreaterThan(estimateTokens(prose) / prose.length);
  });

  it('grows monotonically with text', () => {
    const short = 'Derive the lens maker formula.';
    expect(estimateTokens(short + short)).toBeGreaterThan(estimateTokens(short));
  });
});

describe('planRequest', () => {
  it('counts the completion reserve as spent, the way the provider does', () => {
    const plan = planRequest(['hello'], GROQ_FREE);
    expect(plan.requested).toBe(plan.promptTokens + 3_000);
    expect(plan.ceiling).toBe(7_360);
    expect(plan.fits).toBe(true);
  });

  it('refuses a prompt that fits the limit only if the reply is ignored', () => {
    // ~6,000 prompt tokens: fine on its own, far too big once 3,000 is reserved.
    const big = 'x'.repeat(21_000);
    const plan = planRequest([big], GROQ_FREE);
    expect(plan.promptTokens).toBeGreaterThan(5_000);
    expect(plan.fits).toBe(false);
    expect(plan.headroom).toBeLessThan(0);
  });

  it('would have refused the 16,000-token reservation that caused the original failure', () => {
    const old: TokenBudget = { ...GROQ_FREE, completionReserve: 16_000 };
    expect(planRequest(['a modest prompt'], old).fits).toBe(false);
  });
});

describe('allowances', () => {
  it('leaves the reserve and the margin out of the prompt allowance', () => {
    expect(maxPromptTokens(GROQ_FREE)).toBe(7_360 - 3_000);
  });

  it('gives the variable part whatever the fixed parts do not use', () => {
    const fixed = ['system prompt '.repeat(50), 'question and rubric '.repeat(50)];
    const allowance = variableAllowance(fixed, GROQ_FREE);
    expect(allowance).toBeGreaterThan(0);
    expect(allowance).toBeLessThan(maxPromptTokens(GROQ_FREE));
    expect(variableAllowance(['x'.repeat(100_000)], GROQ_FREE)).toBe(0);
  });
});

describe('transcriptionReserve', () => {
  it('grows with the chunk, since a transcription reply is as long as its source', async () => {
    const { transcriptionReserve } = await import('./tokens.js');
    expect(transcriptionReserve(1_400)).toBeGreaterThan(1_400);
    expect(transcriptionReserve(2_000)).toBeGreaterThan(transcriptionReserve(1_400));
  });

  it('fits a default Groq chunk and its reply inside one request', async () => {
    const { transcriptionReserve } = await import('./tokens.js');
    const chunk = 1_400;
    const fixed = 'x'.repeat(3_200); // ≈1,000 tokens of system prompt and scaffolding
    const plan = planRequest([fixed, 'y'.repeat(chunk * 3.2)], { ...GROQ_FREE, completionReserve: transcriptionReserve(chunk) });
    expect(plan.fits).toBe(true);
  });
});
