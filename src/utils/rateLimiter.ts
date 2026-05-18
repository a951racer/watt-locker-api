/**
 * Rate limiter utility for Strava API requests.
 * Implements a sliding window counter approach with two limits:
 * - 200 requests per 15 minutes
 * - 2000 requests per day
 *
 * Non-persistent across restarts (MVP approach).
 */

export interface RateLimiterConfig {
  /** Maximum requests allowed in the short window (default: 200) */
  shortWindowMax: number;
  /** Short window duration in milliseconds (default: 15 minutes) */
  shortWindowMs: number;
  /** Maximum requests allowed in the long window (default: 2000) */
  longWindowMax: number;
  /** Long window duration in milliseconds (default: 24 hours) */
  longWindowMs: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  shortWindowMax: 200,
  shortWindowMs: 15 * 60 * 1000, // 15 minutes
  longWindowMax: 2000,
  longWindowMs: 24 * 60 * 60 * 1000, // 24 hours
};

export class RateLimiter {
  private readonly config: RateLimiterConfig;
  private requestTimestamps: number[] = [];
  private readonly now: () => number;

  constructor(config?: Partial<RateLimiterConfig>, nowFn?: () => number) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.now = nowFn ?? (() => Date.now());
  }

  /**
   * Check if a request can be made without exceeding rate limits.
   * Returns true if the request is allowed.
   */
  canMakeRequest(): boolean {
    this.pruneOldTimestamps();
    const now = this.now();

    const shortWindowStart = now - this.config.shortWindowMs;
    const shortWindowCount = this.requestTimestamps.filter((t) => t >= shortWindowStart).length;

    if (shortWindowCount >= this.config.shortWindowMax) {
      return false;
    }

    const longWindowStart = now - this.config.longWindowMs;
    const longWindowCount = this.requestTimestamps.filter((t) => t >= longWindowStart).length;

    if (longWindowCount >= this.config.longWindowMax) {
      return false;
    }

    return true;
  }

  /**
   * Record that a request was made.
   */
  recordRequest(): void {
    this.requestTimestamps.push(this.now());
  }

  /**
   * Get the time in milliseconds until the next request can be made.
   * Returns 0 if a request can be made immediately.
   */
  getWaitTime(): number {
    this.pruneOldTimestamps();
    const now = this.now();

    const shortWindowStart = now - this.config.shortWindowMs;
    const shortWindowRequests = this.requestTimestamps.filter((t) => t >= shortWindowStart);

    if (shortWindowRequests.length >= this.config.shortWindowMax) {
      // Wait until the oldest request in the short window expires
      const oldestInWindow = Math.min(...shortWindowRequests);
      return oldestInWindow + this.config.shortWindowMs - now;
    }

    const longWindowStart = now - this.config.longWindowMs;
    const longWindowRequests = this.requestTimestamps.filter((t) => t >= longWindowStart);

    if (longWindowRequests.length >= this.config.longWindowMax) {
      // Wait until the oldest request in the long window expires
      const oldestInWindow = Math.min(...longWindowRequests);
      return oldestInWindow + this.config.longWindowMs - now;
    }

    return 0;
  }

  /**
   * Get the number of remaining requests in the short window.
   */
  getRemainingShortWindow(): number {
    this.pruneOldTimestamps();
    const now = this.now();
    const shortWindowStart = now - this.config.shortWindowMs;
    const count = this.requestTimestamps.filter((t) => t >= shortWindowStart).length;
    return Math.max(0, this.config.shortWindowMax - count);
  }

  /**
   * Get the number of remaining requests in the long window.
   */
  getRemainingLongWindow(): number {
    this.pruneOldTimestamps();
    const now = this.now();
    const longWindowStart = now - this.config.longWindowMs;
    const count = this.requestTimestamps.filter((t) => t >= longWindowStart).length;
    return Math.max(0, this.config.longWindowMax - count);
  }

  /**
   * Remove timestamps older than the long window to prevent unbounded growth.
   */
  private pruneOldTimestamps(): void {
    const cutoff = this.now() - this.config.longWindowMs;
    this.requestTimestamps = this.requestTimestamps.filter((t) => t >= cutoff);
  }
}
