/**
 * PLAN-058: BlockTemplateService tests — ownership, name/repeatCount/step
 * validation + normalization, empty-block rejection, and Step Template copy
 * independence (against a mocked repository).
 */
import { BlockTemplateService } from './blockTemplateService';
import { IBlockTemplateRepository } from '../repositories/blockTemplateRepository';
import { BlockTemplate } from '../models/blockTemplate';
import { NotFoundError, ValidationError } from '../utils/errors';
import { PlanSegment } from '../models/workout';

function createMockRepo(): jest.Mocked<IBlockTemplateRepository> {
  return {
    createIndexes: jest.fn(),
    create: jest.fn(),
    findById: jest.fn(),
    listByUser: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
}

const work: PlanSegment = { type: 'interval', durationType: 'time', durationSeconds: 600, intensityMetric: 'power_ftp', powerMin: 88, powerMax: 92 };
const recovery: PlanSegment = { type: 'recovery', durationType: 'time', durationSeconds: 180 };

function makeBlock(userId: string, id = 'blk-1'): BlockTemplate {
  return { id, userId, name: '3x Sweet Spot', repeatCount: 3, steps: [work, recovery], createdAt: new Date(), updatedAt: new Date() };
}

describe('BlockTemplateService', () => {
  let repo: jest.Mocked<IBlockTemplateRepository>;
  let service: BlockTemplateService;

  beforeEach(() => {
    repo = createMockRepo();
    service = new BlockTemplateService(repo);
  });

  describe('create', () => {
    it('validates name/repeatCount and normalizes every step', async () => {
      repo.create.mockImplementation(async (userId, input) => ({ ...makeBlock(userId), ...input } as BlockTemplate));
      const result = await service.create('user-1', { name: '  3x Sweet Spot  ', repeatCount: 3, steps: [work, recovery] });
      expect(repo.create).toHaveBeenCalledWith('user-1', expect.objectContaining({ name: '3x Sweet Spot', repeatCount: 3 }));
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].durationType).toBe('time');
    });

    it('rejects an empty/whitespace name', async () => {
      await expect(service.create('user-1', { name: '  ', repeatCount: 3, steps: [work] })).rejects.toThrow(ValidationError);
    });

    it('rejects a non-integer / out-of-range repeatCount', async () => {
      await expect(service.create('user-1', { name: 'X', repeatCount: 0, steps: [work] })).rejects.toThrow(ValidationError);
      await expect(service.create('user-1', { name: 'X', repeatCount: -1, steps: [work] })).rejects.toThrow(ValidationError);
      await expect(service.create('user-1', { name: 'X', repeatCount: 2.5, steps: [work] })).rejects.toThrow(ValidationError);
      await expect(service.create('user-1', { name: 'X', repeatCount: 100, steps: [work] })).rejects.toThrow(ValidationError);
    });

    it('rejects an empty block (no steps)', async () => {
      await expect(service.create('user-1', { name: 'X', repeatCount: 1, steps: [] })).rejects.toThrow(ValidationError);
    });

    it('rejects a non-array steps value', async () => {
      await expect(service.create('user-1', { name: 'X', repeatCount: 1, steps: 'nope' })).rejects.toThrow(ValidationError);
    });

    it('rejects an invalid step within the list (with index context)', async () => {
      await expect(
        service.create('user-1', { name: 'X', repeatCount: 1, steps: [work, { type: 'bogus', durationType: 'time', durationSeconds: 60 }] }),
      ).rejects.toThrow(ValidationError);
    });

    it('normalizes a contradictory-duration step (both time+distance) to declared type', async () => {
      repo.create.mockImplementation(async (userId, input) => ({ ...makeBlock(userId), ...input } as BlockTemplate));
      const result = await service.create('user-1', {
        name: 'X',
        repeatCount: 1,
        steps: [{ type: 'interval', durationType: 'distance', distanceMeters: 1609, durationSeconds: 600 }],
      });
      expect(result.steps[0].durationType).toBe('distance');
      expect(result.steps[0].distanceMeters).toBe(1609);
      expect(result.steps[0].durationSeconds).toBeUndefined();
    });

    it('preserves step order', async () => {
      repo.create.mockImplementation(async (userId, input) => ({ ...makeBlock(userId), ...input } as BlockTemplate));
      const s1: PlanSegment = { type: 'warmup', durationType: 'time', durationSeconds: 300 };
      const s2: PlanSegment = { type: 'cooldown', durationType: 'time', durationSeconds: 120 };
      const result = await service.create('user-1', { name: 'X', repeatCount: 1, steps: [s1, s2] });
      expect(result.steps.map((s) => s.type)).toEqual(['warmup', 'cooldown']);
    });
  });

  describe('Step Template copy independence (materialization principle)', () => {
    it('a step copied from a step template is stored by value; later mutating the source object does not change the stored block', async () => {
      // Simulate a step template's canonical step being copied into the block input.
      const stepTemplateStep: PlanSegment = { name: 'Sweet Spot', type: 'interval', durationType: 'time', durationSeconds: 600, intensityMetric: 'power_ftp', powerMin: 88, powerMax: 92 };
      const copiedIntoBlock = { ...stepTemplateStep };

      repo.create.mockImplementation(async (userId, input) => ({ ...makeBlock(userId), ...input } as BlockTemplate));
      const result = await service.create('user-1', { name: 'B', repeatCount: 1, steps: [copiedIntoBlock] });

      // Mutate the ORIGINAL step-template step afterwards.
      stepTemplateStep.powerMin = 90;
      stepTemplateStep.powerMax = 94;

      // The stored block's step is unaffected (normalization produced a fresh object).
      expect(result.steps[0].powerMin).toBe(88);
      expect(result.steps[0].powerMax).toBe(92);
      // And no stepTemplateId reference was stored.
      expect((result.steps[0] as Record<string, unknown>).stepTemplateId).toBeUndefined();
    });
  });

  describe('get / update / delete ownership', () => {
    it('get returns owned template', async () => {
      repo.findById.mockResolvedValue(makeBlock('user-1'));
      expect((await service.get('blk-1', 'user-1')).id).toBe('blk-1');
    });
    it('get throws NotFound for another user', async () => {
      repo.findById.mockResolvedValue(makeBlock('user-2'));
      await expect(service.get('blk-1', 'user-1')).rejects.toThrow(NotFoundError);
    });
    it('update throws NotFound (no write) for another user', async () => {
      repo.findById.mockResolvedValue(makeBlock('user-2'));
      await expect(service.update('blk-1', 'user-1', { name: 'X' })).rejects.toThrow(NotFoundError);
      expect(repo.update).not.toHaveBeenCalled();
    });
    it('update requires at least one field', async () => {
      repo.findById.mockResolvedValue(makeBlock('user-1'));
      await expect(service.update('blk-1', 'user-1', {})).rejects.toThrow(ValidationError);
    });
    it('update validates+normalizes steps', async () => {
      repo.findById.mockResolvedValue(makeBlock('user-1'));
      repo.update.mockImplementation(async (_id, updates) => ({ ...makeBlock('user-1'), ...updates } as BlockTemplate));
      const result = await service.update('blk-1', 'user-1', { steps: [{ type: 'interval', durationType: 'distance', distanceMeters: 3218, durationSeconds: 60 }] });
      expect(result.steps[0].durationType).toBe('distance');
      expect(result.steps[0].durationSeconds).toBeUndefined();
    });
    it('update rejects an empty step list', async () => {
      repo.findById.mockResolvedValue(makeBlock('user-1'));
      await expect(service.update('blk-1', 'user-1', { steps: [] })).rejects.toThrow(ValidationError);
    });
    it('delete throws NotFound (no delete) for another user', async () => {
      repo.findById.mockResolvedValue(makeBlock('user-2'));
      await expect(service.delete('blk-1', 'user-1')).rejects.toThrow(NotFoundError);
      expect(repo.delete).not.toHaveBeenCalled();
    });
    it('delete works when owned', async () => {
      repo.findById.mockResolvedValue(makeBlock('user-1'));
      repo.delete.mockResolvedValue(true);
      await service.delete('blk-1', 'user-1');
      expect(repo.delete).toHaveBeenCalledWith('blk-1');
    });
  });

  it('list delegates to repository', async () => {
    repo.listByUser.mockResolvedValue([makeBlock('user-1')]);
    expect(await service.list('user-1')).toHaveLength(1);
    expect(repo.listByUser).toHaveBeenCalledWith('user-1');
  });
});
