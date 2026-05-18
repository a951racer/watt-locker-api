import { Request, Response, NextFunction } from 'express';
import { createAuthMiddleware } from './auth';
import { IAuthService } from '../services/authService';
import { UserContext } from '../models/user';
import { AuthenticationError } from '../utils/errors';

describe('createAuthMiddleware', () => {
  const mockUserContext: UserContext = {
    userId: 'user-123',
    email: 'test@example.com',
  };

  function createMockAuthService(overrides?: Partial<IAuthService>): IAuthService {
    return {
      register: jest.fn(),
      login: jest.fn(),
      refreshToken: jest.fn(),
      validateToken: jest.fn().mockResolvedValue(mockUserContext),
      ...overrides,
    };
  }

  function createMocks(headers: Record<string, string> = {}) {
    const req = {
      headers,
      correlationId: 'test-correlation-id',
    } as unknown as Request;

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    const next: NextFunction = jest.fn();

    return { req, res, next };
  }

  it('calls next and attaches user context for a valid Bearer token', async () => {
    const authService = createMockAuthService();
    const middleware = createAuthMiddleware(authService);
    const { req, res, next } = createMocks({ authorization: 'Bearer valid-token' });

    await middleware(req, res, next);

    expect(authService.validateToken).toHaveBeenCalledWith('valid-token');
    expect(req.user).toEqual(mockUserContext);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const authService = createMockAuthService();
    const middleware = createAuthMiddleware(authService);
    const { req, res, next } = createMocks({});

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: null,
        errors: [
          expect.objectContaining({
            code: 'AUTHENTICATION_ERROR',
            message: 'Missing or malformed authorization header',
          }),
        ],
        pagination: null,
        correlationId: 'test-correlation-id',
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header does not start with Bearer', async () => {
    const authService = createMockAuthService();
    const middleware = createAuthMiddleware(authService);
    const { req, res, next } = createMocks({ authorization: 'Basic abc123' });

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: null,
        errors: [
          expect.objectContaining({
            code: 'AUTHENTICATION_ERROR',
            message: 'Missing or malformed authorization header',
          }),
        ],
        pagination: null,
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token validation fails (expired token)', async () => {
    const authService = createMockAuthService({
      validateToken: jest.fn().mockRejectedValue(new AuthenticationError('Token expired')),
    });
    const middleware = createAuthMiddleware(authService);
    const { req, res, next } = createMocks({ authorization: 'Bearer expired-token' });

    await middleware(req, res, next);

    expect(authService.validateToken).toHaveBeenCalledWith('expired-token');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: null,
        errors: [
          expect.objectContaining({
            code: 'AUTHENTICATION_ERROR',
            message: 'Invalid or expired access token',
          }),
        ],
        pagination: null,
        correlationId: 'test-correlation-id',
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token validation throws a generic error', async () => {
    const authService = createMockAuthService({
      validateToken: jest.fn().mockRejectedValue(new Error('Something went wrong')),
    });
    const middleware = createAuthMiddleware(authService);
    const { req, res, next } = createMocks({ authorization: 'Bearer malformed-token' });

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: null,
        errors: [
          expect.objectContaining({
            code: 'AUTHENTICATION_ERROR',
            message: 'Invalid or expired access token',
          }),
        ],
        pagination: null,
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('uses "unknown" as correlationId when correlationId is not set on request', async () => {
    const authService = createMockAuthService();
    const middleware = createAuthMiddleware(authService);
    const req = { headers: {} } as unknown as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const next: NextFunction = jest.fn();

    await middleware(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: 'unknown',
      }),
    );
  });

  it('returns 401 when Authorization header is "Bearer " with empty token', async () => {
    const authService = createMockAuthService({
      validateToken: jest.fn().mockRejectedValue(new AuthenticationError('Invalid token')),
    });
    const middleware = createAuthMiddleware(authService);
    const { req, res, next } = createMocks({ authorization: 'Bearer ' });

    await middleware(req, res, next);

    expect(authService.validateToken).toHaveBeenCalledWith('');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
