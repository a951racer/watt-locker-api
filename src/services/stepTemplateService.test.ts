/**
 * PLAN-057: StepTemplateService tests — ownership enforcement + canonical step
 * validation/normalization (against a mocked repository).
 */
import { StepTemplateService } from './stepTemplateService';
import { IStepTemplateRepository } from '../repositories/stepTemplateRepository';
import { StepTemplate } from '../models/stepTemplate';
import { NotFoundError, ValidationError } from '../utils/errors';
import { PlanSegment } from '../models/workout';

function createMockRepo(): jest.Mocked<IStepTemplateRepository> {
  return {
    createIndexes: jest.fn(),
    create: jest.fn(),
    findById: jest.fn(),
    listByUser: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
}

const validTimeStep: PlanSegment = {
  type: 'interval',
  durationType: 'time',
  durationSeconds: 600,
  intensityMetric: 'power_ftp',
  powerMin: 88,
  powerMax: 92,
};

function makeTemplate(userId: string, id = 'tpl-1'): StepTemplate {
  return {
    id,
    userId,
    name: 'Sweet Spot 10',
    step: validTimeStep,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('StepTemplateService', () => {
  let repo: jest.Mocked<IStepTemplateRepository>;
  let service: StepTemplateService;

  beforeEach(() => {
    repo = createMockRepo();
    service = new StepTemplateService(repo);
  });

  describe('create', () => {
    it('validates name and normalizes the step, then persists', async () => {
      repo.create.mockImplementation(async (userId) => makeTemplate(userId));
      await service.create('user-1', { name: '  Sweet Spot 10  ', step: { ...validTimeStep } });
      expect(repo.create).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          name: 'Sweet Spot 10', // trimmed
          step: expect.objectContaining({ durationType: 'time', durationSeconds: 600 }),
        }),
      );
    });

    it('rejects an empty/whitespace name', async () => {
      await expect(service.create('user-1', { name: '   ', step: validTimeStep })).rejects.toThrow(ValidationError);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects an invalid step type', async () => {
      await expect(
        service.create('user-1', { name: 'X', step: { type: 'bogus', durationType: 'time', durationSeconds: 60 } }),
      ).rejects.toThrow(ValidationError);
    });

    it('normalizes contradictory duration (both time+distance) to the declared type', async () => {
      repo.create.mockImplementation(async (userId, input) => ({ ...makeTemplate(userId), step: input.step }));
      const result = await service.create('user-1', {
        name: 'X',
        step: { type: 'interval', durationType: 'distance', distanceMeters: 1609, durationSeconds: 600 },
      });
      expect(result.step.durationType).toBe('distance');
      expect(result.step.distanceMeters).toBe(1609);
      expect(result.step.durationSeconds).toBeUndefined();
    });

    it('rejects a time step with no positive duration', async () => {
      await expect(
        service.create('user-1', { name: 'X', step: { type: 'interval', durationType: 'time' } }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects a power range where min > max', async () => {
      await expect(
        service.create('user-1', {
          name: 'X',
          step: { type: 'interval', durationType: 'time', durationSeconds: 60, powerMin: 100, powerMax: 50 },
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('get / ownership', () => {
    it('returns the template when owned by the user', async () => {
      repo.findById.mockResolvedValue(makeTemplate('user-1'));
      const result = await service.get('tpl-1', 'user-1');
      expect(result.id).toBe('tpl-1');
    });

    it('throws NotFound when the template belongs to another user', async () => {
      repo.findById.mockResolvedValue(makeTemplate('user-2'));
      await expect(service.get('tpl-1', 'user-1')).rejects.toThrow(NotFoundError);
    });

    it('throws NotFound when the template does not exist', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.get('missing', 'user-1')).rejects.toThrow(NotFoundError);
    });
  });

  describe('update / ownership', () => {
    it('updates when owned', async () => {
      repo.findById.mockResolvedValue(makeTemplate('user-1'));
      repo.update.mockResolvedValue({ ...makeTemplate('user-1'), name: 'Renamed' });
      const result = await service.update('tpl-1', 'user-1', { name: 'Renamed' });
      expect(result.name).toBe('Renamed');
      expect(repo.update).toHaveBeenCalledWith('tpl-1', { name: 'Renamed' });
    });

    it('throws NotFound (no update) when owned by another user', async () => {
      repo.findById.mockResolvedValue(makeTemplate('user-2'));
      await expect(service.update('tpl-1', 'user-1', { name: 'X' })).rejects.toThrow(NotFoundError);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('requires at least one updatable field', async () => {
      repo.findById.mockResolvedValue(makeTemplate('user-1'));
      await expect(service.update('tpl-1', 'user-1', {})).rejects.toThrow(ValidationError);
    });

    it('validates+normalizes step on update', async () => {
      repo.findById.mockResolvedValue(makeTemplate('user-1'));
      repo.update.mockImplementation(async (_id, updates) => ({ ...makeTemplate('user-1'), ...updates } as StepTemplate));
      const result = await service.update('tpl-1', 'user-1', {
        step: { type: 'interval', durationType: 'distance', distanceMeters: 3218, durationSeconds: 60 },
      });
      expect(result.step.durationType).toBe('distance');
      expect(result.step.durationSeconds).toBeUndefined();
    });
  });

  describe('delete / ownership', () => {
    it('deletes when owned', async () => {
      repo.findById.mockResolvedValue(makeTemplate('user-1'));
      repo.delete.mockResolvedValue(true);
      await service.delete('tpl-1', 'user-1');
      expect(repo.delete).toHaveBeenCalledWith('tpl-1');
    });

    it('throws NotFound (no delete) when owned by another user', async () => {
      repo.findById.mockResolvedValue(makeTemplate('user-2'));
      await expect(service.delete('tpl-1', 'user-1')).rejects.toThrow(NotFoundError);
      expect(repo.delete).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('delegates to repository listByUser', async () => {
      repo.listByUser.mockResolvedValue([makeTemplate('user-1')]);
      const result = await service.list('user-1');
      expect(result).toHaveLength(1);
      expect(repo.listByUser).toHaveBeenCalledWith('user-1');
    });
  });
});
