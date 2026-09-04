/**
 * PLAN-058: Block Template route tests (HTTP layer with a mocked service).
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createBlockTemplatesRouter } from './blockTemplates';
import { IBlockTemplateService } from '../services/blockTemplateService';
import { BlockTemplate } from '../models/blockTemplate';
import { NotFoundError, ValidationError } from '../utils/errors';
import { errorHandler } from '../middleware/errorHandler';
import { PlanSegment } from '../models/workout';

function createMockService(): jest.Mocked<IBlockTemplateService> {
  return { list: jest.fn(), get: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() };
}

function fakeAuthMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.user = { userId: 'user-123', email: 'test@example.com' };
  next();
}
function rejectingAuthMiddleware(_req: Request, res: Response): void {
  res.status(401).json({ data: null, errors: [{ code: 'AUTHENTICATION_ERROR', message: 'Authentication required' }], pagination: null });
}

function createTestApp(service: IBlockTemplateService, auth = fakeAuthMiddleware) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.correlationId = 'test-correlation-id'; next(); });
  app.use('/api/templates/blocks', createBlockTemplatesRouter(service, auth));
  app.use(errorHandler);
  return app;
}

const work: PlanSegment = { type: 'interval', durationType: 'time', durationSeconds: 600, intensityMetric: 'power_ftp', powerMin: 88, powerMax: 92 };
const recovery: PlanSegment = { type: 'recovery', durationType: 'time', durationSeconds: 180 };

function blk(overrides: Partial<BlockTemplate> = {}): BlockTemplate {
  return {
    id: 'blk-1', userId: 'user-123', name: '3x Sweet Spot', repeatCount: 3,
    steps: [work, recovery], createdAt: new Date('2024-06-01'), updatedAt: new Date('2024-06-02'), ...overrides,
  };
}

describe('Block Template Routes', () => {
  let service: jest.Mocked<IBlockTemplateService>;
  let app: express.Application;

  beforeEach(() => {
    service = createMockService();
    app = createTestApp(service);
  });

  it('GET lists only the authenticated user\'s templates', async () => {
    service.list.mockResolvedValue([blk()]);
    const res = await request(app).get('/api/templates/blocks');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(service.list).toHaveBeenCalledWith('user-123');
  });

  it('returns 401 when unauthenticated', async () => {
    const unauthApp = createTestApp(service, rejectingAuthMiddleware);
    const res = await request(unauthApp).get('/api/templates/blocks');
    expect(res.status).toBe(401);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('POST creates with name/repeatCount/steps', async () => {
    service.create.mockResolvedValue(blk());
    const res = await request(app).post('/api/templates/blocks').send({ name: '3x Sweet Spot', repeatCount: 3, steps: [work, recovery] });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('blk-1');
    expect(res.body.data.steps).toHaveLength(2);
    expect(service.create).toHaveBeenCalledWith('user-123', { name: '3x Sweet Spot', repeatCount: 3, steps: [work, recovery] });
  });

  it('POST rejects invalid name (400)', async () => {
    service.create.mockRejectedValue(new ValidationError('name is required', { field: 'name' }));
    const res = await request(app).post('/api/templates/blocks').send({ name: '', repeatCount: 3, steps: [work] });
    expect(res.status).toBe(400);
  });

  it('POST rejects invalid repeatCount (400)', async () => {
    service.create.mockRejectedValue(new ValidationError('repeatCount must be an integer', { field: 'repeatCount' }));
    const res = await request(app).post('/api/templates/blocks').send({ name: 'X', repeatCount: 0, steps: [work] });
    expect(res.status).toBe(400);
  });

  it('POST rejects an invalid step (400)', async () => {
    service.create.mockRejectedValue(new ValidationError('steps[0]: step.type invalid', { field: 'steps[0]' }));
    const res = await request(app).post('/api/templates/blocks').send({ name: 'X', repeatCount: 1, steps: [{ type: 'bogus' }] });
    expect(res.status).toBe(400);
  });

  it('POST rejects a non-object body (array) with 400', async () => {
    const res = await request(app).post('/api/templates/blocks').send([1, 2, 3]);
    expect(res.status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('GET /:id returns owned template', async () => {
    service.get.mockResolvedValue(blk());
    const res = await request(app).get('/api/templates/blocks/blk-1');
    expect(res.status).toBe(200);
    expect(service.get).toHaveBeenCalledWith('blk-1', 'user-123');
  });

  it('GET /:id returns 404 for another user\'s template', async () => {
    service.get.mockRejectedValue(new NotFoundError('Block template not found'));
    const res = await request(app).get('/api/templates/blocks/other');
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('PUT updates owned template', async () => {
    service.update.mockResolvedValue(blk({ name: 'Renamed', repeatCount: 4 }));
    const res = await request(app).put('/api/templates/blocks/blk-1').send({ name: 'Renamed', repeatCount: 4 });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Renamed');
    expect(service.update).toHaveBeenCalledWith('blk-1', 'user-123', { name: 'Renamed', repeatCount: 4, steps: undefined });
  });

  it('PUT returns 404 for another user\'s template', async () => {
    service.update.mockRejectedValue(new NotFoundError('Block template not found'));
    const res = await request(app).put('/api/templates/blocks/other').send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  it('DELETE removes owned template (204)', async () => {
    service.delete.mockResolvedValue(undefined);
    const res = await request(app).delete('/api/templates/blocks/blk-1');
    expect(res.status).toBe(204);
    expect(service.delete).toHaveBeenCalledWith('blk-1', 'user-123');
  });

  it('DELETE returns 404 for another user\'s template', async () => {
    service.delete.mockRejectedValue(new NotFoundError('Block template not found'));
    const res = await request(app).delete('/api/templates/blocks/other');
    expect(res.status).toBe(404);
  });
});
