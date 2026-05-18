import { Request, Response, NextFunction } from 'express';
import { UserContext } from '../models/user';
import { IAuthService } from '../services/authService';
import { AuthenticationError } from '../utils/errors';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserContext;
    }
  }
}

/**
 * Creates a JWT authentication middleware that validates Bearer tokens
 * and attaches the authenticated user context to the request.
 *
 * Uses dependency injection for the auth service to enable testing with mocks.
 */
export function createAuthMiddleware(authService: IAuthService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      const error = new AuthenticationError('Missing or malformed authorization header');
      const correlationId = req.correlationId ?? 'unknown';

      res.status(401).json({
        data: null,
        errors: [
          {
            code: error.code,
            message: error.message,
          },
        ],
        pagination: null,
        correlationId,
      });
      return;
    }

    const token = authHeader.slice(7); // Remove 'Bearer ' prefix

    try {
      const userContext = await authService.validateToken(token);
      req.user = userContext;
      next();
    } catch {
      const error = new AuthenticationError('Invalid or expired access token');
      const correlationId = req.correlationId ?? 'unknown';

      res.status(401).json({
        data: null,
        errors: [
          {
            code: error.code,
            message: error.message,
          },
        ],
        pagination: null,
        correlationId,
      });
    }
  };
}
