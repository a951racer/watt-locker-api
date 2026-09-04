/**
 * PLAN-058: Block Template service.
 *
 * Enforces user ownership on every operation (a template belonging to another
 * user is NotFound, never leaked). Validates the template name and default
 * repeat count, requires a non-empty step list, and validates + normalizes
 * EACH contained step with the shared canonical validator
 * (utils/planSegment#validateAndNormalizeStep) so blocks reuse one definition
 * of a valid step. No nested blocks and no template references are stored: the
 * steps are self-contained canonical PlanSegments.
 *
 * Empty-block decision: persistence REQUIRES at least one step. An empty block
 * may exist transiently in UI editing state, but a Block Template with zero
 * steps is rejected here (consistent with the product's blueprint model — an
 * empty reusable block has no meaning).
 */
import {
  BlockTemplate,
  CreateBlockTemplateInput,
  UpdateBlockTemplateInput,
  BLOCK_TEMPLATE_NAME_MAX_LENGTH,
  BLOCK_TEMPLATE_MIN_REPEAT_COUNT,
  BLOCK_TEMPLATE_MAX_REPEAT_COUNT,
} from '../models/blockTemplate';
import { IBlockTemplateRepository } from '../repositories/blockTemplateRepository';
import { validateAndNormalizeStep } from '../utils/planSegment';
import { PlanSegment } from '../models/workout';
import { NotFoundError, ValidationError } from '../utils/errors';

export interface IBlockTemplateService {
  list(userId: string): Promise<BlockTemplate[]>;
  get(id: string, userId: string): Promise<BlockTemplate>;
  create(userId: string, input: { name: unknown; repeatCount: unknown; steps: unknown }): Promise<BlockTemplate>;
  update(
    id: string,
    userId: string,
    input: { name?: unknown; repeatCount?: unknown; steps?: unknown },
  ): Promise<BlockTemplate>;
  delete(id: string, userId: string): Promise<void>;
}

/** Validate + trim a required template name. */
function validateName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('name is required and must be a non-empty string', { field: 'name' });
  }
  const trimmed = value.trim();
  if (trimmed.length > BLOCK_TEMPLATE_NAME_MAX_LENGTH) {
    throw new ValidationError(
      `name must be at most ${BLOCK_TEMPLATE_NAME_MAX_LENGTH} characters`,
      { field: 'name' },
    );
  }
  return trimmed;
}

/** Validate a positive-integer repeat count within bounds. */
function validateRepeatCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError('repeatCount must be an integer', { field: 'repeatCount' });
  }
  if (value < BLOCK_TEMPLATE_MIN_REPEAT_COUNT || value > BLOCK_TEMPLATE_MAX_REPEAT_COUNT) {
    throw new ValidationError(
      `repeatCount must be between ${BLOCK_TEMPLATE_MIN_REPEAT_COUNT} and ${BLOCK_TEMPLATE_MAX_REPEAT_COUNT}`,
      { field: 'repeatCount' },
    );
  }
  return value;
}

/** Validate + normalize a non-empty ordered list of canonical steps. */
function validateSteps(value: unknown): PlanSegment[] {
  if (!Array.isArray(value)) {
    throw new ValidationError('steps must be an array', { field: 'steps' });
  }
  if (value.length === 0) {
    throw new ValidationError('a block template must contain at least one step', { field: 'steps' });
  }
  // Validate + normalize each step, preserving order. Guard against any
  // accidental nested-block shape by validating each element as a single step
  // (validateAndNormalizeStep requires a valid step `type` and rejects arrays).
  return value.map((step, i) => {
    try {
      return validateAndNormalizeStep(step);
    } catch (err) {
      if (err instanceof ValidationError) {
        throw new ValidationError(`steps[${i}]: ${err.message}`, { field: `steps[${i}]` });
      }
      throw err;
    }
  });
}

export class BlockTemplateService implements IBlockTemplateService {
  constructor(private readonly repository: IBlockTemplateRepository) {}

  async list(userId: string): Promise<BlockTemplate[]> {
    return this.repository.listByUser(userId);
  }

  async get(id: string, userId: string): Promise<BlockTemplate> {
    const template = await this.repository.findById(id);
    if (!template || template.userId !== userId) {
      throw new NotFoundError('Block template not found');
    }
    return template;
  }

  async create(
    userId: string,
    input: { name: unknown; repeatCount: unknown; steps: unknown },
  ): Promise<BlockTemplate> {
    const payload: CreateBlockTemplateInput = {
      name: validateName(input.name),
      repeatCount: validateRepeatCount(input.repeatCount),
      steps: validateSteps(input.steps),
    };
    return this.repository.create(userId, payload);
  }

  async update(
    id: string,
    userId: string,
    input: { name?: unknown; repeatCount?: unknown; steps?: unknown },
  ): Promise<BlockTemplate> {
    const existing = await this.repository.findById(id);
    if (!existing || existing.userId !== userId) {
      throw new NotFoundError('Block template not found');
    }

    const updates: UpdateBlockTemplateInput = {};
    if (input.name !== undefined) updates.name = validateName(input.name);
    if (input.repeatCount !== undefined) updates.repeatCount = validateRepeatCount(input.repeatCount);
    if (input.steps !== undefined) updates.steps = validateSteps(input.steps);

    if (updates.name === undefined && updates.repeatCount === undefined && updates.steps === undefined) {
      throw new ValidationError('No updatable fields provided (name, repeatCount, and/or steps required)');
    }

    const updated = await this.repository.update(id, updates);
    if (!updated) {
      throw new NotFoundError('Block template not found');
    }
    return updated;
  }

  async delete(id: string, userId: string): Promise<void> {
    const existing = await this.repository.findById(id);
    if (!existing || existing.userId !== userId) {
      throw new NotFoundError('Block template not found');
    }
    await this.repository.delete(id);
  }
}
