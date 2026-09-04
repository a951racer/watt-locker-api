/**
 * PLAN-058: Block Template CRUD routes.
 *
 * Mounted at /api/templates/blocks (sibling of /api/templates/steps). All
 * routes require JWT auth and are strictly user-scoped: a template owned by
 * another user returns 404 so its existence is never revealed.
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { IBlockTemplateService } from '../services/blockTemplateService';
import { successResponse } from '../utils/response';
import { ValidationError } from '../utils/errors';

export function createBlockTemplatesRouter(
  blockTemplateService: IBlockTemplateService,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  router.use(authMiddleware);

  /** GET /api/templates/blocks — list the user's Block Templates (updatedAt DESC). */
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await blockTemplateService.list(req.user!.userId);
      res.status(200).json(successResponse(items));
    } catch (err) {
      next(err);
    }
  });

  /** POST /api/templates/blocks — create. Body: { name, repeatCount, steps }. */
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new ValidationError('Request body must be an object');
      }
      const { name, repeatCount, steps } = body as Record<string, unknown>;
      const created = await blockTemplateService.create(req.user!.userId, { name, repeatCount, steps });
      res.status(201).json(successResponse(created));
    } catch (err) {
      next(err);
    }
  });

  /** GET /api/templates/blocks/:id — read a single owned Block Template. */
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const template = await blockTemplateService.get(req.params.id as string, req.user!.userId);
      res.status(200).json(successResponse(template));
    } catch (err) {
      next(err);
    }
  });

  /** PUT /api/templates/blocks/:id — update name/repeatCount/steps. Owner-scoped. */
  router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new ValidationError('Request body must be an object');
      }
      const { name, repeatCount, steps } = body as Record<string, unknown>;
      const updated = await blockTemplateService.update(req.params.id as string, req.user!.userId, {
        name,
        repeatCount,
        steps,
      });
      res.status(200).json(successResponse(updated));
    } catch (err) {
      next(err);
    }
  });

  /** DELETE /api/templates/blocks/:id — delete. Owner-scoped. No Activity effect. */
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await blockTemplateService.delete(req.params.id as string, req.user!.userId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
