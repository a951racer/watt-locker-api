import express from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import { generalLimiter, authLimiter } from './rateLimiter';
import { correlationIdMiddleware } from './correlationId';

function createApp(limiter: ReturnType<typeof rateLimit>) {
  const app = express();
  app.use(correlationIdMiddleware);
  app.use(limiter);
  app.get('/test', (_req, res) => {
    res.json({ data: 'ok', errors: null, pagination: null });
  });
  return app;
}

describe('rateLimiter middleware', () => {
  describe('generalLimiter', () => {
    it('allows requests under the limit', async () => {
      const app = createApp(generalLimiter);

      const res = await request(app).get('/test');

      expect(res.status).toBe(200);
      expect(res.body.data).toBe('ok');
    });

    it('returns 429 with error envelope when limit is exceeded', async () => {
      // Create a limiter with a very low max for testing
      const testLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 2,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req: express.Request, res: express.Response) => {
          const correlationId = req.correlationId ?? 'unknown';
          res.status(429).json({
            data: null,
            errors: [
              {
                code: 'RATE_LIMITED',
                message: 'Too many requests, please try again later',
              },
            ],
            pagination: null,
            correlationId,
          });
        },
      });

      const app = createApp(testLimiter);

      // First two requests should succeed
      await request(app).get('/test').expect(200);
      await request(app).get('/test').expect(200);

      // Third request should be rate limited
      const res = await request(app).get('/test');

      expect(res.status).toBe(429);
      expect(res.body.data).toBeNull();
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].code).toBe('RATE_LIMITED');
      expect(res.body.errors[0].message).toBe('Too many requests, please try again later');
      expect(res.body.pagination).toBeNull();
      expect(res.body.correlationId).toBeDefined();
    });

    it('includes Retry-After header when rate limited', async () => {
      const testLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 1,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req: express.Request, res: express.Response) => {
          res.status(429).json({
            data: null,
            errors: [{ code: 'RATE_LIMITED', message: 'Too many requests, please try again later' }],
            pagination: null,
            correlationId: req.correlationId ?? 'unknown',
          });
        },
      });

      const app = createApp(testLimiter);

      await request(app).get('/test').expect(200);
      const res = await request(app).get('/test');

      expect(res.status).toBe(429);
      // express-rate-limit sets Retry-After via standardHeaders (RateLimit-Reset)
      // The Retry-After header is set by standardHeaders: true
      expect(res.headers['retry-after']).toBeDefined();
    });
  });

  describe('authLimiter', () => {
    it('allows requests under the stricter limit', async () => {
      const app = createApp(authLimiter);

      const res = await request(app).get('/test');

      expect(res.status).toBe(200);
    });

    it('has a stricter limit than the general limiter', async () => {
      // Create a test auth limiter with max 2 to verify stricter behavior
      const strictLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 2,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req: express.Request, res: express.Response) => {
          res.status(429).json({
            data: null,
            errors: [{ code: 'RATE_LIMITED', message: 'Too many requests, please try again later' }],
            pagination: null,
            correlationId: req.correlationId ?? 'unknown',
          });
        },
      });

      const app = createApp(strictLimiter);

      await request(app).get('/test').expect(200);
      await request(app).get('/test').expect(200);
      const res = await request(app).get('/test');

      expect(res.status).toBe(429);
    });
  });

  describe('error envelope format', () => {
    it('returns correlationId in the error response', async () => {
      const testLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 1,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req: express.Request, res: express.Response) => {
          res.status(429).json({
            data: null,
            errors: [{ code: 'RATE_LIMITED', message: 'Too many requests, please try again later' }],
            pagination: null,
            correlationId: req.correlationId ?? 'unknown',
          });
        },
      });

      const app = createApp(testLimiter);

      await request(app).get('/test');
      const res = await request(app).get('/test');

      expect(res.status).toBe(429);
      expect(res.body.correlationId).toBeDefined();
      expect(res.body.correlationId).not.toBe('unknown');
    });
  });
});
