/**
 * PLAN-057: Step Template route tests (HTTP layer with a mocked service).
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createStepTemplatesRouter } from './stepTemplates';
import { IStepTemplateService } from '../services/stepTemplateService';
import { StepTemplate } from '../models/stepTemplate';
import { NotFoundError, ValidationError } from '../utils/errors';
import { errorHandler } from '../middleware/errorHandler';
import { PlanSegment } from '../models/workout';

function createMockService(): jest.Mocked<IStepTemplateService> {
  return {
    list: jest.fn(),
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
}

/** Fake auth middleware that attaches a pre-authenticated user. */
function fakeAuthMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.user = { userId: 'user-123', email: 'test@example.com' };
  next();
}

/** Auth middleware that rejects (simulates unauthenticated request). */
function rejectingAuthMiddleware(_req: Request, res: Response): void {
  res.status(401).json({ data: null, errors: [{ code: 'AUTHENTICATION_ERROR', message: 'Authentication required' }], pagination: null });
}

function createTestApp(service: IStepTemplateService, auth = fakeAuthMiddleware) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.correlationId = 'test-correlation-id'; next(); });
  app.use('/api/templates/steps', createStepTemplatesRouter(service, auth));
  app.use(errorHandler);
  return app;
}

const step: PlanSegment = {
  type: 'interval',
  durationType: 'time',
  durationSeconds: 600,
  intensityMetric: 'power_ftp',
  powerMin: 88,
  powerMax: 92,
};

function tpl(overrides: Partial<StepTemplate> = {}): StepTemplate {
  return {
    id: 'tpl-1',
    userId: 'user-123',
    name: 'Sweet Spot 10',
    step,
    createdAt: new Date('2024-06-01'),
    updatedAt: new Date('2024-06-02'),
    ...overrides,
  };
}

describe('Step Template Routes', () => {
  let service: jest.Mocked<IStepTemplateService>;
  let app: express.Application;

  beforeEach(() => {
    service = createMockService();
    app = createTestApp(service);
  });

  describe('GET /api/templates/steps', () => {
    it('lists only the authenticated user\'s templates', async () => {
      service.list.mockResolvedValue([tpl()]);
      const res = await request(app).get('/api/templates/steps');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(service.list).toHaveBeenCalledWith('user-123');
    });
  });

  describe('authentication', () => {
    it('returns 401 when unauthenticated', async () => {
      const unauthApp = createTestApp(service, rejectingAuthMiddleware);
      const res = await request(unauthApp).get('/api/templates/steps');
      expect(res.status).toBe(401);
      expect(service.list).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/templates/steps', () => {
    it('creates a template for the authenticated user', async () => {
      service.create.mockResolvedValue(tpl());
      const res = await request(app).post('/api/templates/steps').send({ name: 'Sweet Spot 10', step });
      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe('tpl-1');
      expect(service.create).toHaveBeenCalledWith('user-123', { name: 'Sweet Spot 10', step });
    });

    it('rejects an invalid template name (service ValidationError → 400)', async () => {
      service.create.mockRejectedValue(new ValidationError('name is required', { field: 'name' }));
      const res = await request(app).post('/api/templates/steps').send({ name: '   ', step });
      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('rejects an invalid canonical step (400)', async () => {
      service.create.mockRejectedValue(new ValidationError('step.type invalid', { field: 'step.type' }));
      const res = await request(app).post('/api/templates/steps').send({ name: 'X', step: { type: 'bogus' } });
      expect(res.status).toBe(400);
    });

    it('rejects a non-object (array) body (400)', async () => {
      const res = await request(app).post('/api/templates/steps').send([1, 2, 3]);
      expect(res.status).toBe(400);
      expect(service.create).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/templates/steps/:id', () => {
    it('returns the template when owned', async () => {
      service.get.mockResolvedValue(tpl());
      const res = await request(app).get('/api/templates/steps/tpl-1');
      expect(res.status).toBe(200);
      expect(service.get).toHaveBeenCalledWith('tpl-1', 'user-123');
    });

    it('returns 404 for another user\'s template (no existence leak)', async () => {
      service.get.mockRejectedValue(new NotFoundError('Step template not found'));
      const res = await request(app).get('/api/templates/steps/other');
      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
    });
  });

  describe('PUT /api/templates/steps/:id', () => {
    it('updates the template when owned', async () => {
      service.update.mockResolvedValue(tpl({ name: 'Renamed' }));
      const res = await request(app).put('/api/templates/steps/tpl-1').send({ name: 'Renamed' });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Renamed');
      expect(service.update).toHaveBeenCalledWith('tpl-1', 'user-123', { name: 'Renamed', step: undefined });
    });

    it('returns 404 when updating another user\'s template', async () => {
      service.update.mockRejectedValue(new NotFoundError('Step template not found'));
      const res = await request(app).put('/api/templates/steps/other').send({ name: 'X' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/templates/steps/:id', () => {
    it('deletes the template when owned (204)', async () => {
      service.delete.mockResolvedValue(undefined);
      const res = await request(app).delete('/api/templates/steps/tpl-1');
      expect(res.status).toBe(204);
      expect(service.delete).toHaveBeenCalledWith('tpl-1', 'user-123');
    });

    it('returns 404 when deleting another user\'s template', async () => {
      service.delete.mockRejectedValue(new NotFoundError('Step template not found'));
      const res = await request(app).delete('/api/templates/steps/other');
      expect(res.status).toBe(404);
    });
  });
});
