/**
 * PLAN-057: Step Template CRUD routes.
 *
 * Mounted at /api/templates/steps (scales to /api/templates/blocks later).
 * All routes require JWT auth and are strictly user-scoped: a template owned by
 * another user returns 404 (NotFound) so its existence is never revealed.
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { IStepTemplateService } from '../services/stepTemplateService';
import { successResponse } from '../utils/response';
import { ValidationError } from '../utils/errors';

export function createStepTemplatesRouter(
  stepTemplateService: IStepTemplateService,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  router.use(authMiddleware);

  /**
   * GET /api/templates/steps
   * List the authenticated user's Step Templates (most-recently-updated first).
   */
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await stepTemplateService.list(req.user!.userId);
      res.status(200).json(successResponse(items));
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/templates/steps
   * Create a Step Template. Body: { name, step }.
   */
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new ValidationError('Request body must be an object');
      }
      const { name, step } = body as Record<string, unknown>;
      const created = await stepTemplateService.create(req.user!.userId, { name, step });
      res.status(201).json(successResponse(created));
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/templates/steps/:id
   * Read a single Step Template owned by the authenticated user.
   */
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const template = await stepTemplateService.get(req.params.id as string, req.user!.userId);
      res.status(200).json(successResponse(template));
    } catch (err) {
      next(err);
    }
  });

  /**
   * PUT /api/templates/steps/:id
   * Update a Step Template (name and/or canonical step). Owner-scoped.
   */
  router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new ValidationError('Request body must be an object');
      }
      const { name, step } = body as Record<string, unknown>;
      const updated = await stepTemplateService.update(req.params.id as string, req.user!.userId, {
        name,
        step,
      });
      res.status(200).json(successResponse(updated));
    } catch (err) {
      next(err);
    }
  });

  /**
   * DELETE /api/templates/steps/:id
   * Delete a Step Template. Owner-scoped. No effect on any Activity data.
   */
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await stepTemplateService.delete(req.params.id as string, req.user!.userId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
