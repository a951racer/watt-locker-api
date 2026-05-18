import { RateLimiter } from './rateLimiter';

describe('RateLimiter', () => {
  let currentTime: number;
  const nowFn = () => currentTime;

  beforeEach(() => {
    currentTime = 1000000;
  });

  describe('canMakeRequest', () => {
    it('should allow requests when no requests have been made', () => {
      const limiter = new RateLimiter({}, nowFn);
      expect(limiter.canMakeRequest()).toBe(true);
    });

    it('should deny requests when short window limit is reached', () => {
      const limiter = new RateLimiter(
        { shortWindowMax: 3, shortWindowMs: 1000 },
        nowFn,
      );

      limiter.recordRequest();
      limiter.recordRequest();
      limiter.recordRequest();

      expect(limiter.canMakeRequest()).toBe(false);
    });

    it('should deny requests when long window limit is reached', () => {
      const limiter = new RateLimiter(
        { shortWindowMax: 100, shortWindowMs: 1000, longWindowMax: 5, longWindowMs: 10000 },
        nowFn,
      );

      for (let i = 0; i < 5; i++) {
        limiter.recordRequest();
      }

      expect(limiter.canMakeRequest()).toBe(false);
    });

    it('should allow requests after short window expires', () => {
      const limiter = new RateLimiter(
        { shortWindowMax: 2, shortWindowMs: 1000 },
        nowFn,
      );

      limiter.recordRequest();
      limiter.recordRequest();
      expect(limiter.canMakeRequest()).toBe(false);

      // Advance time past the short window
      currentTime += 1001;
      expect(limiter.canMakeRequest()).toBe(true);
    });

    it('should allow requests after long window expires', () => {
      const limiter = new RateLimiter(
        { shortWindowMax: 100, shortWindowMs: 1000, longWindowMax: 3, longWindowMs: 5000 },
        nowFn,
      );

      limiter.recordRequest();
      limiter.recordRequest();
      limiter.recordRequest();
      expect(limiter.canMakeRequest()).toBe(false);

      // Advance time past the long window
      currentTime += 5001;
      expect(limiter.canMakeRequest()).toBe(true);
    });
  });

  describe('getWaitTime', () => {
    it('should return 0 when requests are allowed', () => {
      const limiter = new RateLimiter({}, nowFn);
      expect(limiter.getWaitTime()).toBe(0);
    });

    it('should return time until short window opens', () => {
      const limiter = new RateLimiter(
        { shortWindowMax: 2, shortWindowMs: 1000 },
        nowFn,
      );

      limiter.recordRequest();
      currentTime += 200;
      limiter.recordRequest();

      // Both requests are within the window, wait time should be based on oldest
      const waitTime = limiter.getWaitTime();
      // Oldest request was at 1000000, window is 1000ms, so it expires at 1001000
      // Current time is 1000200, so wait = 1001000 - 1000200 = 800
      expect(waitTime).toBe(800);
    });

    it('should return time until long window opens when long limit hit', () => {
      const limiter = new RateLimiter(
        { shortWindowMax: 100, shortWindowMs: 1000, longWindowMax: 2, longWindowMs: 5000 },
        nowFn,
      );

      limiter.recordRequest();
      currentTime += 1500; // Move past short window for first request
      limiter.recordRequest();

      const waitTime = limiter.getWaitTime();
      // Oldest request at 1000000, long window is 5000ms, expires at 1005000
      // Current time is 1001500, so wait = 1005000 - 1001500 = 3500
      expect(waitTime).toBe(3500);
    });
  });

  describe('getRemainingShortWindow', () => {
    it('should return max when no requests made', () => {
      const limiter = new RateLimiter(
        { shortWindowMax: 200, shortWindowMs: 900000 },
        nowFn,
      );
      expect(limiter.getRemainingShortWindow()).toBe(200);
    });

    it('should decrease as requests are made', () => {
      const limiter = new RateLimiter(
        { shortWindowMax: 5, shortWindowMs: 1000 },
        nowFn,
      );

      limiter.recordRequest();
      limiter.recordRequest();

      expect(limiter.getRemainingShortWindow()).toBe(3);
    });

    it('should recover after window expires', () => {
      const limiter = new RateLimiter(
        { shortWindowMax: 5, shortWindowMs: 1000 },
        nowFn,
      );

      limiter.recordRequest();
      limiter.recordRequest();
      expect(limiter.getRemainingShortWindow()).toBe(3);

      currentTime += 1001;
      expect(limiter.getRemainingShortWindow()).toBe(5);
    });
  });

  describe('getRemainingLongWindow', () => {
    it('should return max when no requests made', () => {
      const limiter = new RateLimiter(
        { longWindowMax: 2000, longWindowMs: 86400000 },
        nowFn,
      );
      expect(limiter.getRemainingLongWindow()).toBe(2000);
    });

    it('should decrease as requests are made', () => {
      const limiter = new RateLimiter(
        { longWindowMax: 10, longWindowMs: 86400000 },
        nowFn,
      );

      for (let i = 0; i < 4; i++) {
        limiter.recordRequest();
      }

      expect(limiter.getRemainingLongWindow()).toBe(6);
    });
  });

  describe('default configuration', () => {
    it('should use Strava rate limits by default', () => {
      const limiter = new RateLimiter(undefined, nowFn);

      // Should allow up to 200 requests in 15 minutes
      expect(limiter.getRemainingShortWindow()).toBe(200);
      expect(limiter.getRemainingLongWindow()).toBe(2000);
    });
  });

  describe('pruning old timestamps', () => {
    it('should not grow unbounded over time', () => {
      const limiter = new RateLimiter(
        { shortWindowMax: 100, shortWindowMs: 1000, longWindowMax: 100, longWindowMs: 5000 },
        nowFn,
      );

      // Make requests over a long period
      for (let i = 0; i < 50; i++) {
        limiter.recordRequest();
        currentTime += 200;
      }

      // After pruning, old timestamps should be removed
      // The limiter should still function correctly
      expect(limiter.canMakeRequest()).toBe(true);
    });
  });
});
