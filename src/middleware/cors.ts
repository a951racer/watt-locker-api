import cors from 'cors';
import { RequestHandler } from 'express';
import { config } from '../config/env';

/**
 * Creates a CORS middleware configured with allowed origins from environment config.
 * Allows requests from the WattLocker_Web domain (configurable via CORS_ORIGIN env var).
 */
export function createCorsMiddleware(): RequestHandler {
  return cors({
    origin: config.cors.origin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: true,
  });
}
