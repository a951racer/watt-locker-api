import { Router, Request, Response, NextFunction } from 'express';
import { IAuthService } from '../services/authService';
import { ValidationError } from '../utils/errors';
import { successResponse } from '../utils/response';

/**
 * Creates the auth router with injected AuthService dependency.
 * All endpoints are public (no JWT auth required).
 */
export function createAuthRouter(authService: IAuthService): Router {
  const router = Router();

  /**
   * POST /api/auth/register
   * Register a new user with email and password.
   */
  router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body;

      validateAuthInput(email, password);

      const result = await authService.register(email, password);
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/auth/login
   * Authenticate user and return JWT tokens.
   */
  router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body;

      validateAuthInput(email, password);

      const result = await authService.login(email, password);
      res.status(200).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/auth/refresh
   * Refresh an expired access token using a valid refresh token.
   */
  router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken || typeof refreshToken !== 'string') {
        throw new ValidationError('Refresh token is required', { field: 'refreshToken' });
      }

      const result = await authService.refreshToken(refreshToken);
      res.status(200).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Validates email format and password minimum length for register/login requests.
 */
function validateAuthInput(email: unknown, password: unknown): void {
  if (!email || typeof email !== 'string') {
    throw new ValidationError('Email is required', { field: 'email' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new ValidationError('Invalid email format', { field: 'email' });
  }

  if (!password || typeof password !== 'string') {
    throw new ValidationError('Password is required', { field: 'password' });
  }

  if (password.length < 8) {
    throw new ValidationError('Password must be at least 8 characters long', {
      field: 'password',
    });
  }
}
