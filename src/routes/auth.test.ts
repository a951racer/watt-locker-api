import express from 'express';
import request from 'supertest';
import { createAuthRouter } from './auth';
import { IAuthService } from '../services/authService';
import { AuthResult } from '../models/user';
import { errorHandler } from '../middleware/errorHandler';
import { AuthenticationError, ConflictError } from '../utils/errors';

/** Create a mock AuthService */
function createMockAuthService(): jest.Mocked<IAuthService> {
  return {
    register: jest.fn(),
    login: jest.fn(),
    refreshToken: jest.fn(),
    validateToken: jest.fn(),
  };
}

/** Create a minimal Express app with the auth router and error handler */
function createTestApp(authService: IAuthService) {
  const app = express();
  app.use(express.json());
  // Attach a dummy correlationId for error handler compatibility
  app.use((req, _res, next) => {
    req.correlationId = 'test-correlation-id';
    next();
  });
  app.use('/api/auth', createAuthRouter(authService));
  app.use(errorHandler);
  return app;
}

const mockAuthResult: AuthResult = {
  accessToken: 'access-token-123',
  refreshToken: 'refresh-token-456',
  expiresIn: 900,
  user: {
    id: 'user-1',
    email: 'test@example.com',
    createdAt: new Date('2024-01-01'),
  },
};

describe('Auth Routes', () => {
  let mockAuthService: jest.Mocked<IAuthService>;
  let app: express.Application;

  beforeEach(() => {
    mockAuthService = createMockAuthService();
    app = createTestApp(mockAuthService);
  });

  describe('POST /api/auth/register', () => {
    it('should register a user and return 201 with auth result', async () => {
      mockAuthService.register.mockResolvedValue(mockAuthResult);

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'test@example.com', password: 'password123' });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-456',
        expiresIn: 900,
      });
      expect(res.body.errors).toBeNull();
      expect(mockAuthService.register).toHaveBeenCalledWith('test@example.com', 'password123');
    });

    it('should return 400 when email is missing', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('email');
      expect(mockAuthService.register).not.toHaveBeenCalled();
    });

    it('should return 400 when email format is invalid', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'not-an-email', password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('email');
      expect(mockAuthService.register).not.toHaveBeenCalled();
    });

    it('should return 400 when password is too short', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'test@example.com', password: 'short' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('password');
      expect(mockAuthService.register).not.toHaveBeenCalled();
    });

    it('should return 400 when password is missing', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'test@example.com' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('password');
      expect(mockAuthService.register).not.toHaveBeenCalled();
    });

    it('should return 409 when user already exists', async () => {
      mockAuthService.register.mockRejectedValue(
        new ConflictError('A user with this email already exists'),
      );

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'existing@example.com', password: 'password123' });

      expect(res.status).toBe(409);
      expect(res.body.errors[0].code).toBe('CONFLICT');
    });
  });

  describe('POST /api/auth/login', () => {
    it('should login a user and return 200 with auth result', async () => {
      mockAuthService.login.mockResolvedValue(mockAuthResult);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'test@example.com', password: 'password123' });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-456',
        expiresIn: 900,
      });
      expect(res.body.errors).toBeNull();
      expect(mockAuthService.login).toHaveBeenCalledWith('test@example.com', 'password123');
    });

    it('should return 400 when email is missing', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('email');
      expect(mockAuthService.login).not.toHaveBeenCalled();
    });

    it('should return 400 when email format is invalid', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'invalid', password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('email');
    });

    it('should return 400 when password is too short', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'test@example.com', password: '1234567' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('password');
    });

    it('should return 401 when credentials are invalid', async () => {
      mockAuthService.login.mockRejectedValue(
        new AuthenticationError('Invalid email or password'),
      );

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'test@example.com', password: 'wrongpassword' });

      expect(res.status).toBe(401);
      expect(res.body.errors[0].code).toBe('AUTHENTICATION_ERROR');
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('should refresh tokens and return 200 with new auth result', async () => {
      mockAuthService.refreshToken.mockResolvedValue(mockAuthResult);

      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: 'valid-refresh-token' });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-456',
        expiresIn: 900,
      });
      expect(res.body.errors).toBeNull();
      expect(mockAuthService.refreshToken).toHaveBeenCalledWith('valid-refresh-token');
    });

    it('should return 400 when refreshToken is missing', async () => {
      const res = await request(app).post('/api/auth/refresh').send({});

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('refreshToken');
      expect(mockAuthService.refreshToken).not.toHaveBeenCalled();
    });

    it('should return 400 when refreshToken is not a string', async () => {
      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: 12345 });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('refreshToken');
    });

    it('should return 401 when refresh token is invalid or expired', async () => {
      mockAuthService.refreshToken.mockRejectedValue(
        new AuthenticationError('Invalid or expired refresh token'),
      );

      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: 'expired-token' });

      expect(res.status).toBe(401);
      expect(res.body.errors[0].code).toBe('AUTHENTICATION_ERROR');
    });
  });
});
