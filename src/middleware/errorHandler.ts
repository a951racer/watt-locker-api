import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { ErrorResponse } from '../models/api';

/**
 * Global error handler middleware.
 * Catches all errors thrown in route handlers and returns a formatted response
 * in the standard envelope format with a correlation ID.
 * Internal details (stack traces, internal paths) are never exposed.
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const correlationId = req.correlationId ?? 'unknown';

  if (err instanceof AppError) {
    const response: ErrorResponse = {
      data: null,
      errors: [
        {
          code: err.code,
          message: err.message,
          ...(err.field && { field: err.field }),
          ...(err.details !== undefined && { details: err.details }),
        },
      ],
      pagination: null,
      correlationId,
    };

    res.status(err.statusCode).json(response);
    return;
  }

  // Unexpected errors — never expose internal details
  console.error('[INTERNAL_ERROR]', err.message, err.stack);

  const response: ErrorResponse = {
    data: null,
    errors: [
      {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
    ],
    pagination: null,
    correlationId,
  };

  res.status(500).json(response);
}
