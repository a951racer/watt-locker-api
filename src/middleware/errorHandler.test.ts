import { Request, Response, NextFunction } from 'express';
import { errorHandler } from './errorHandler';
import {
  ValidationError,
  AuthenticationError,
  NotFoundError,
  ConflictError,
} from '../utils/errors';

describe('errorHandler middleware', () => {
  function createMocks(correlationId = 'test-correlation-id') {
    const req = { correlationId } as unknown as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const next: NextFunction = jest.fn();
    return { req, res, next };
  }

  it('handles ValidationError with 400 status', () => {
    const { req, res, next } = createMocks();
    const err = new ValidationError('Invalid email', { field: 'email' });

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      data: null,
      errors: [{ code: 'VALIDATION_ERROR', message: 'Invalid email', field: 'email' }],
      pagination: null,
      correlationId: 'test-correlation-id',
    });
  });

  it('handles AuthenticationError with 401 status', () => {
    const { req, res, next } = createMocks();
    const err = new AuthenticationError('Token expired');

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      data: null,
      errors: [{ code: 'AUTHENTICATION_ERROR', message: 'Token expired' }],
      pagination: null,
      correlationId: 'test-correlation-id',
    });
  });

  it('handles NotFoundError with 404 status', () => {
    const { req, res, next } = createMocks();
    const err = new NotFoundError('Workout not found');

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      data: null,
      errors: [{ code: 'NOT_FOUND', message: 'Workout not found' }],
      pagination: null,
      correlationId: 'test-correlation-id',
    });
  });

  it('handles ConflictError with 409 status', () => {
    const { req, res, next } = createMocks();
    const err = new ConflictError('Duplicate workout', { details: { existingId: 'xyz' } });

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      data: null,
      errors: [{ code: 'CONFLICT', message: 'Duplicate workout', details: { existingId: 'xyz' } }],
      pagination: null,
      correlationId: 'test-correlation-id',
    });
  });

  it('handles unexpected errors with 500 status and no internal details', () => {
    const { req, res, next } = createMocks();
    const err = new Error('Something broke internally at /src/secret/path.ts:42');

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      data: null,
      errors: [{ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }],
      pagination: null,
      correlationId: 'test-correlation-id',
    });
  });

  it('uses "unknown" when correlationId is missing from request', () => {
    const req = {} as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const next: NextFunction = jest.fn();
    const err = new Error('oops');

    errorHandler(err, req, res, next);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.correlationId).toBe('unknown');
  });
});
