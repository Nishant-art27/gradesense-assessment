import { RequestTooLargeError } from '../errors.js';

/**
 * Keeps a provider's tokens-per-minute allowance from being exceeded.
 *
 * Two properties matter and both are deliberate:
 *
 *  1. **Requests run one at a time.** The pipeline's per-question calls and the
 *     chunked document reads would otherwise fire together, and a burst of
 *     individually small requests trips the same limit as one large one.
 *  2. **A request is charged before it is sent, at the size the provider will
 *     admit it at** — prompt plus the reserved completion — and reconciled to
 *     the provider's own usage figure afterwards. Charging the reservation is
 *     what stops the admission check failing; reconciling afterwards is what
 *     stops a 3,000-token reservation that came back as 800 tokens of JSON from
 *     idling the next request for no reason.
 *
 * When the provider reports its own remaining allowance in the response, that
 * figure is trusted over the local ledger: the server's count is the one that
 * decides, and it also sees requests made from anywhere else with the same key.
 */

export interface LimiterOutcome {
  /** Tokens the provider says the request actually consumed, when it says. */
  usedTokens: number | null;
  /** Allowance left in the current window, as reported by the provider. */
  remainingTokens?: number | null;
  /** Milliseconds until the provider's window resets, when reported. */
  resetInMs?: number | null;
}

interface LedgerEntry {
  at: number;
  tokens: number;
}

interface ServerSnapshot {
  at: number;
  remaining: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  tokensPerMinute: number;
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called whenever a request has to wait, so the delay is visible in the log. */
  onWait?: (ms: number, reason: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TokenRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onWait: (ms: number, reason: string) => void;

  private ledger: LedgerEntry[] = [];
  private server: ServerSnapshot | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    this.limit = options.tokensPerMinute;
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.onWait = options.onWait ?? (() => {});
  }

  /**
   * Runs `task` once there is room for `reserve` tokens, after every request
   * scheduled before it. `task` reports what the provider said was used.
   */
  async schedule<T>(reserve: number, task: () => Promise<[T, LimiterOutcome]>): Promise<T> {
    if (reserve > this.limit) {
      throw new RequestTooLargeError(
        `One request would need about ${reserve} tokens, but the provider allows at most ${this.limit} per minute. Split the content into smaller pieces.`,
        reserve,
        this.limit,
      );
    }

    const release = await this.acquire();
    try {
      await this.waitForRoom(reserve);

      const entry: LedgerEntry = { at: this.now(), tokens: reserve };
      this.ledger.push(entry);

      const [value, outcome] = await task();

      if (typeof outcome.usedTokens === 'number' && outcome.usedTokens >= 0) {
        entry.tokens = outcome.usedTokens;
      }
      if (typeof outcome.remainingTokens === 'number') {
        const at = this.now();
        this.server = {
          at,
          remaining: outcome.remainingTokens,
          resetAt: at + (outcome.resetInMs ?? this.windowMs),
        };
      }

      return value;
    } finally {
      release();
    }
  }

  /** Tokens charged inside the current window. Exposed for tests and the health endpoint. */
  usedInWindow(): number {
    this.prune();
    return this.ledger.reduce((total, entry) => total + entry.tokens, 0);
  }

  private async waitForRoom(reserve: number): Promise<void> {
    for (;;) {
      this.prune();
      const now = this.now();

      const localRoom = this.limit - this.usedInWindow();

      // The server's figure is authoritative while it is fresh; local requests
      // made since the snapshot are subtracted from it.
      let room = localRoom;
      let resetAt = this.ledger[0] ? this.ledger[0].at + this.windowMs : now;
      if (this.server && this.server.resetAt > now) {
        const sinceSnapshot = this.ledger
          .filter((entry) => entry.at > this.server!.at)
          .reduce((total, entry) => total + entry.tokens, 0);
        const serverRoom = this.server.remaining - sinceSnapshot;
        if (serverRoom < room) {
          room = serverRoom;
          resetAt = this.server.resetAt;
        }
      }

      if (reserve <= room) return;

      const wait = Math.max(250, resetAt - now);
      this.onWait(
        wait,
        `waiting ${Math.ceil(wait / 1000)}s for the token allowance: ${reserve} needed, ${Math.max(0, room)} available`,
      );
      await this.sleep(wait);
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    this.ledger = this.ledger.filter((entry) => entry.at > cutoff);
  }

  /** A promise-chain mutex: each caller waits for the one before it. */
  private async acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => held);
    await previous;
    return release;
  }
}
