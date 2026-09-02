import { describe, expect, it } from 'vitest';
import { RequestTooLargeError } from '../errors.js';
import { TokenRateLimiter, type LimiterOutcome } from './rate-limit.js';

/**
 * A fake clock stands in for real time, so a "minute" passes when the test says
 * so and the suite stays fast. `sleep` advances the clock instead of waiting.
 */
function fakeClock() {
  let now = 1_000_000;
  const waits: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    waits,
  };
}

const done = (used: number | null = null): LimiterOutcome => ({ usedTokens: used });

describe('TokenRateLimiter', () => {
  it('lets requests through while the window has room', async () => {
    const clock = fakeClock();
    const limiter = new TokenRateLimiter({ tokensPerMinute: 8_000, now: clock.now, sleep: clock.sleep });

    const a = await limiter.schedule(3_000, async () => ['a', done()]);
    const b = await limiter.schedule(3_000, async () => ['b', done()]);

    expect([a, b]).toEqual(['a', 'b']);
    expect(clock.waits).toEqual([]);
    expect(limiter.usedInWindow()).toBe(6_000);
  });

  it('waits for the window to roll over instead of exceeding it', async () => {
    const clock = fakeClock();
    const limiter = new TokenRateLimiter({ tokensPerMinute: 8_000, now: clock.now, sleep: clock.sleep });

    await limiter.schedule(5_000, async () => [1, done()]);
    await limiter.schedule(5_000, async () => [2, done()]);

    // The second request could not fit until the first left the window.
    expect(clock.waits.length).toBeGreaterThan(0);
    expect(clock.waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000);
    expect(limiter.usedInWindow()).toBe(5_000);
  });

  it('reconciles the reservation to what the provider says was used', async () => {
    const clock = fakeClock();
    const limiter = new TokenRateLimiter({ tokensPerMinute: 8_000, now: clock.now, sleep: clock.sleep });

    // Reserved 5,000, actually used 1,200: the next 5,000 must not have to wait.
    await limiter.schedule(5_000, async () => [1, done(1_200)]);
    await limiter.schedule(5_000, async () => [2, done(1_000)]);

    expect(clock.waits).toEqual([]);
    expect(limiter.usedInWindow()).toBe(2_200);
  });

  it('trusts a fresher, tighter figure from the server', async () => {
    const clock = fakeClock();
    const limiter = new TokenRateLimiter({ tokensPerMinute: 8_000, now: clock.now, sleep: clock.sleep });

    // Locally only 1,000 used, but the server says 500 remain (another client
    // shares the key). The next 2,000-token request has to wait for the reset.
    await limiter.schedule(1_000, async () => [1, { usedTokens: 1_000, remainingTokens: 500, resetInMs: 10_000 }]);
    await limiter.schedule(2_000, async () => [2, done(2_000)]);

    expect(clock.waits).toEqual([10_000]);
  });

  it('runs requests one at a time, in order', async () => {
    const clock = fakeClock();
    const limiter = new TokenRateLimiter({ tokensPerMinute: 100_000, now: clock.now, sleep: clock.sleep });
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const run = (name: string) =>
      limiter.schedule(10, async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(name);
        inFlight -= 1;
        return [name, done()];
      });

    await Promise.all([run('first'), run('second'), run('third')]);

    expect(order).toEqual(['first', 'second', 'third']);
    expect(maxInFlight).toBe(1);
  });

  it('refuses outright a request bigger than the whole allowance', async () => {
    const clock = fakeClock();
    const limiter = new TokenRateLimiter({ tokensPerMinute: 8_000, now: clock.now, sleep: clock.sleep });

    await expect(limiter.schedule(9_000, async () => [1, done()])).rejects.toBeInstanceOf(RequestTooLargeError);
    expect(clock.waits).toEqual([]);
  });

  it('keeps the charge for a request that failed after being sent', async () => {
    const clock = fakeClock();
    const limiter = new TokenRateLimiter({ tokensPerMinute: 8_000, now: clock.now, sleep: clock.sleep });

    await expect(
      limiter.schedule(3_000, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(limiter.usedInWindow()).toBe(3_000);
  });
});
