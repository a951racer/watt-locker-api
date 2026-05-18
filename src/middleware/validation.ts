import { Request, Response, NextFunction } from 'express';
import { z, ZodSchema, ZodError } from 'zod';
import { ErrorResponse } from '../models/api';

/**
 * Validation schemas for all request payloads.
 */

/** Auth register request schema */
export const registerSchema = z.object({
  email: z
    .string({ required_error: 'Email is required' })
    .email('Invalid email format'),
  password: z
    .string({ required_error: 'Password is required' })
    .min(8, 'Password must be at least 8 characters long'),
});

/** Auth login request schema */
export const loginSchema = z.object({
  email: z
    .string({ required_error: 'Email is required' })
    .email('Invalid email format'),
  password: z
    .string({ required_error: 'Password is required' })
    .min(1, 'Password is required'),
});

/** Auth refresh token request schema */
export const refreshTokenSchema = z.object({
  refreshToken: z
    .string({ required_error: 'Refresh token is required' })
    .min(1, 'Refresh token is required'),
});

/** Settings update request schema */
export const settingsUpdateSchema = z.object({
  driveStoragePath: z
    .string()
    .min(1, 'driveStoragePath must be a non-empty string')
    .optional(),
  driveInboxPath: z
    .string()
    .min(1, 'driveInboxPath must be a non-empty string')
    .optional(),
  connectedSources: z
    .array(
      z.object({
        provider: z.enum(['manual', 'strava', 'trainingpeaks', 'garmin'], {
          errorMap: () => ({
            message: 'Invalid provider. Valid providers: manual, strava, trainingpeaks, garmin',
          }),
        }),
        connected: z.boolean({
          required_error: 'Each connected source must have a boolean "connected" field',
        }),
        connectedAt: z.string().datetime().optional(),
        oauthTokenEncrypted: z.string().optional(),
      }),
    )
    .optional(),
}).strict();

/** Workout update request schema */
export const workoutUpdateSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string({ invalid_type_error: 'Each tag must be a string' })).optional(),
  activityType: z
    .string()
    .min(1, 'activityType must be a non-empty string')
    .optional(),
});

/** Upload request schema (for JSON-based uploads) */
export const uploadSchema = z.object({
  file: z.string({ required_error: 'File data is required' }).min(1, 'File data is required'),
  fileName: z
    .string({ required_error: 'fileName is required' })
    .min(1, 'fileName is required'),
  dataSource: z
    .enum(['manual', 'strava', 'trainingpeaks', 'garmin'])
    .optional()
    .default('manual'),
});

/**
 * Formats a ZodError into a human-readable error message.
 */
function formatZodError(error: ZodError): { message: string; field?: string } {
  const firstIssue = error.issues[0];
  const field = firstIssue.path.length > 0 ? firstIssue.path.join('.') : undefined;
  const message = firstIssue.message;

  return { message, field };
}

/**
 * Creates a validation middleware that validates req.body against the provided Zod schema.
 * Returns 400 with a descriptive error message if validation fails.
 *
 * @param schema - A Zod schema to validate the request body against
 * @returns Express middleware function
 */
export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const { message, field } = formatZodError(result.error);
      const correlationId = req.correlationId ?? 'unknown';

      const response: ErrorResponse = {
        data: null,
        errors: [
          {
            code: 'VALIDATION_ERROR',
            message,
            ...(field && { field }),
          },
        ],
        pagination: null,
        correlationId,
      };

      res.status(400).json(response);
      return;
    }

    // Replace req.body with the parsed (and potentially transformed) data
    req.body = result.data;
    next();
  };
}
