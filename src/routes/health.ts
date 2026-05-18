import { Router, Request, Response } from 'express';

/**
 * Creates the health check router.
 * GET /api/health — returns basic service status (no auth required).
 */
export function createHealthRouter(): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
