import { Request, Response, NextFunction } from 'express';
import { correlationIdMiddleware } from './correlationId';

describe('correlationIdMiddleware', () => {
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function createMocks() {
    const req = {} as Request;
    const res = {
      setHeader: jest.fn(),
    } as unknown as Response;
    const next: NextFunction = jest.fn();
    return { req, res, next };
  }

  it('assigns a UUID v4 correlation ID to the request', () => {
    const { req, res, next } = createMocks();

    correlationIdMiddleware(req, res, next);

    expect(req.correlationId).toMatch(UUID_REGEX);
  });

  it('sets the X-Correlation-Id response header', () => {
    const { req, res, next } = createMocks();

    correlationIdMiddleware(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-Id', req.correlationId);
  });

  it('calls next()', () => {
    const { req, res, next } = createMocks();

    correlationIdMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('generates unique IDs for each request', () => {
    const { req: req1, res: res1, next: next1 } = createMocks();
    const { req: req2, res: res2, next: next2 } = createMocks();

    correlationIdMiddleware(req1, res1, next1);
    correlationIdMiddleware(req2, res2, next2);

    expect(req1.correlationId).not.toBe(req2.correlationId);
  });
});
