import { Request, Response, NextFunction } from 'express';
import {
  validate,
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  settingsUpdateSchema,
  workoutUpdateSchema,
  uploadSchema,
} from './validation';

describe('validate middleware', () => {
  function createMocks(body: unknown = {}) {
    const req = {
      body,
      correlationId: 'test-correlation-id',
    } as unknown as Request;

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    const next: NextFunction = jest.fn();

    return { req, res, next };
  }

  describe('validate factory', () => {
    it('calls next when body is valid', () => {
      const { req, res, next } = createMocks({ email: 'user@example.com', password: 'password123' });
      const middleware = validate(registerSchema);

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns 400 with error response when body is invalid', () => {
      const { req, res, next } = createMocks({});
      const middleware = validate(registerSchema);

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: null,
          errors: [
            expect.objectContaining({
              code: 'VALIDATION_ERROR',
            }),
          ],
          pagination: null,
          correlationId: 'test-correlation-id',
        }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('uses "unknown" as correlationId when not set on request', () => {
      const req = { body: {}, headers: {} } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response;
      const next: NextFunction = jest.fn();

      const middleware = validate(registerSchema);
      middleware(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: 'unknown',
        }),
      );
    });

    it('replaces req.body with parsed data on success', () => {
      const { req, res, next } = createMocks({
        email: 'user@example.com',
        password: 'password123',
      });
      const middleware = validate(registerSchema);

      middleware(req, res, next);

      expect(req.body).toEqual({ email: 'user@example.com', password: 'password123' });
    });
  });

  describe('registerSchema', () => {
    it('accepts valid email and password', () => {
      const { req, res, next } = createMocks({
        email: 'test@example.com',
        password: 'securepass123',
      });
      validate(registerSchema)(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('rejects missing email', () => {
      const { req, res, next } = createMocks({ password: 'securepass123' });
      validate(registerSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: [expect.objectContaining({ field: 'email' })],
        }),
      );
    });

    it('rejects invalid email format', () => {
      const { req, res, next } = createMocks({ email: 'not-an-email', password: 'securepass123' });
      validate(registerSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: [
            expect.objectContaining({
              message: 'Invalid email format',
              field: 'email',
            }),
          ],
        }),
      );
    });

    it('rejects password shorter than 8 characters', () => {
      const { req, res, next } = createMocks({ email: 'test@example.com', password: 'short' });
      validate(registerSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: [
            expect.objectContaining({
              message: 'Password must be at least 8 characters long',
              field: 'password',
            }),
          ],
        }),
      );
    });

    it('rejects non-string email', () => {
      const { req, res, next } = createMocks({ email: 123, password: 'securepass123' });
      validate(registerSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: [expect.objectContaining({ field: 'email' })],
        }),
      );
    });
  });

  describe('loginSchema', () => {
    it('accepts valid email and password', () => {
      const { req, res, next } = createMocks({ email: 'user@test.com', password: 'pass' });
      validate(loginSchema)(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('rejects missing password', () => {
      const { req, res, next } = createMocks({ email: 'user@test.com' });
      validate(loginSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('refreshTokenSchema', () => {
    it('accepts valid refresh token', () => {
      const { req, res, next } = createMocks({ refreshToken: 'some-token-value' });
      validate(refreshTokenSchema)(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('rejects missing refresh token', () => {
      const { req, res, next } = createMocks({});
      validate(refreshTokenSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects empty refresh token', () => {
      const { req, res, next } = createMocks({ refreshToken: '' });
      validate(refreshTokenSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('settingsUpdateSchema', () => {
    it('accepts valid settings update with driveStoragePath', () => {
      const { req, res, next } = createMocks({ driveStoragePath: 'MyFolder/Workouts' });
      validate(settingsUpdateSchema)(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('accepts valid settings update with driveInboxPath', () => {
      const { req, res, next } = createMocks({ driveInboxPath: 'MyFolder/Inbox' });
      validate(settingsUpdateSchema)(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('accepts valid connectedSources array', () => {
      const { req, res, next } = createMocks({
        connectedSources: [{ provider: 'strava', connected: true }],
      });
      validate(settingsUpdateSchema)(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('rejects empty driveStoragePath', () => {
      const { req, res, next } = createMocks({ driveStoragePath: '' });
      validate(settingsUpdateSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: [
            expect.objectContaining({
              message: 'driveStoragePath must be a non-empty string',
              field: 'driveStoragePath',
            }),
          ],
        }),
      );
    });

    it('rejects invalid provider in connectedSources', () => {
      const { req, res, next } = createMocks({
        connectedSources: [{ provider: 'invalid', connected: true }],
      });
      validate(settingsUpdateSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects connectedSources with missing connected field', () => {
      const { req, res, next } = createMocks({
        connectedSources: [{ provider: 'strava' }],
      });
      validate(settingsUpdateSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects unknown fields due to strict mode', () => {
      const { req, res, next } = createMocks({ unknownField: 'value' });
      validate(settingsUpdateSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('workoutUpdateSchema', () => {
    it('accepts valid workout update with title', () => {
      const { req, res, next } = createMocks({ title: 'Morning Ride' });
      validate(workoutUpdateSchema)(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('accepts valid workout update with all fields', () => {
      const { req, res, next } = createMocks({
        title: 'Morning Ride',
        description: 'A nice ride',
        tags: ['outdoor', 'endurance'],
        activityType: 'ride',
      });
      validate(workoutUpdateSchema)(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('accepts empty object (all fields optional)', () => {
      const { req, res, next } = createMocks({});
      validate(workoutUpdateSchema)(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('rejects non-string title', () => {
      const { req, res, next } = createMocks({ title: 123 });
      validate(workoutUpdateSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: [expect.objectContaining({ field: 'title' })],
        }),
      );
    });

    it('rejects non-array tags', () => {
      const { req, res, next } = createMocks({ tags: 'not-an-array' });
      validate(workoutUpdateSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: [expect.objectContaining({ field: 'tags' })],
        }),
      );
    });

    it('rejects non-string items in tags array', () => {
      const { req, res, next } = createMocks({ tags: [123, 'valid'] });
      validate(workoutUpdateSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects empty activityType', () => {
      const { req, res, next } = createMocks({ activityType: '' });
      validate(workoutUpdateSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('uploadSchema', () => {
    it('accepts valid upload payload', () => {
      const { req, res, next } = createMocks({
        file: 'base64encodeddata',
        fileName: 'workout.fit',
      });
      validate(uploadSchema)(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.body.dataSource).toBe('manual');
    });

    it('accepts upload with explicit dataSource', () => {
      const { req, res, next } = createMocks({
        file: 'base64encodeddata',
        fileName: 'workout.fit',
        dataSource: 'strava',
      });
      validate(uploadSchema)(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.body.dataSource).toBe('strava');
    });

    it('rejects missing file', () => {
      const { req, res, next } = createMocks({ fileName: 'workout.fit' });
      validate(uploadSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects missing fileName', () => {
      const { req, res, next } = createMocks({ file: 'base64data' });
      validate(uploadSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects invalid dataSource', () => {
      const { req, res, next } = createMocks({
        file: 'base64data',
        fileName: 'workout.fit',
        dataSource: 'invalid-source',
      });
      validate(uploadSchema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});
