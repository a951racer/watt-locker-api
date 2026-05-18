import {
  AppError,
  ValidationError,
  AuthenticationError,
  NotFoundError,
  ConflictError,
} from './errors';

describe('custom error classes', () => {
  describe('ValidationError', () => {
    it('has status 400 and correct code', () => {
      const err = new ValidationError('Invalid email format');

      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.message).toBe('Invalid email format');
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
    });

    it('supports field and details options', () => {
      const err = new ValidationError('Required', { field: 'name', details: { min: 1 } });

      expect(err.field).toBe('name');
      expect(err.details).toEqual({ min: 1 });
    });
  });

  describe('AuthenticationError', () => {
    it('has status 401 and default message', () => {
      const err = new AuthenticationError();

      expect(err.statusCode).toBe(401);
      expect(err.code).toBe('AUTHENTICATION_ERROR');
      expect(err.message).toBe('Authentication required');
    });

    it('accepts a custom message', () => {
      const err = new AuthenticationError('Token expired');

      expect(err.message).toBe('Token expired');
    });
  });

  describe('NotFoundError', () => {
    it('has status 404 and default message', () => {
      const err = new NotFoundError();

      expect(err.statusCode).toBe(404);
      expect(err.code).toBe('NOT_FOUND');
      expect(err.message).toBe('Resource not found');
    });

    it('accepts a custom message', () => {
      const err = new NotFoundError('Workout not found');

      expect(err.message).toBe('Workout not found');
    });
  });

  describe('ConflictError', () => {
    it('has status 409 and correct code', () => {
      const err = new ConflictError('Duplicate workout detected');

      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('CONFLICT');
      expect(err.message).toBe('Duplicate workout detected');
    });

    it('supports details option', () => {
      const err = new ConflictError('Duplicate', { details: { existingId: 'abc' } });

      expect(err.details).toEqual({ existingId: 'abc' });
    });
  });
});
