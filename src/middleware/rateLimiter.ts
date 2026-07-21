import rateLimit, { Options } from 'express-rate-limit';
import { Request, Response } from 'express';
import { ErrorResponse } from '../models/api';

/**
 * Creates a rate limit handler that returns a 429 response in the standard
 * API error envelope format with a Retry-After header.
 */
function rateLimitHandler(req: Request, res: Response): void {
  const correlationId = req.correlationId ?? 'unknown';

  const response: ErrorResponse = {
    data: null,
    errors: [
      {
        code: 'RATE_LIMITED',
        message: 'Too many requests, please try again later',
      },
    ],
    pagination: null,
    correlationId,
  };

  res.status(429).json(response);
}

/**
 * Shared rate limiter options.
 */
const baseOptions: Partial<Options> = {
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers (includes Retry-After)
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  handler: rateLimitHandler,
};

/**
 * General API rate limiter.
 * Allows 300 requests per 15-minute window per IP.
 */
export const generalLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
});

/**
 * Strict rate limiter for authentication endpoints.
 * Allows 10 requests per 15-minute window per IP to mitigate brute-force attacks.
 */
export const authLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
});
