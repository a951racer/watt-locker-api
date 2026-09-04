/**
 * PLAN-057: Step Template service.
 *
 * Enforces user ownership on every operation (mirrors WorkoutService): a
 * template belonging to another user is treated as NotFound so we never leak
 * its existence. Validates + normalizes the canonical step before persistence
 * using the shared canonical validator (utils/planSegment), so Activities and
 * Templates share one definition of a valid step.
 */
import {
  StepTemplate,
  CreateStepTemplateInput,
  UpdateStepTemplateInput,
  STEP_TEMPLATE_NAME_MAX_LENGTH,
} from '../models/stepTemplate';
import { IStepTemplateRepository } from '../repositories/stepTemplateRepository';
import { validateAndNormalizeStep } from '../utils/planSegment';
import { NotFoundError, ValidationError } from '../utils/errors';

export interface IStepTemplateService {
  list(userId: string): Promise<StepTemplate[]>;
  get(id: string, userId: string): Promise<StepTemplate>;
  create(userId: string, input: { name: unknown; step: unknown }): Promise<StepTemplate>;
  update(id: string, userId: string, input: { name?: unknown; step?: unknown }): Promise<StepTemplate>;
  delete(id: string, userId: string): Promise<void>;
}

/** Validate + trim a required template name. */
function validateName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('name is required and must be a non-empty string', { field: 'name' });
  }
  const trimmed = value.trim();
  if (trimmed.length > STEP_TEMPLATE_NAME_MAX_LENGTH) {
    throw new ValidationError(
      `name must be at most ${STEP_TEMPLATE_NAME_MAX_LENGTH} characters`,
      { field: 'name' },
    );
  }
  return trimmed;
}

export class StepTemplateService implements IStepTemplateService {
  constructor(private readonly repository: IStepTemplateRepository) {}

  async list(userId: string): Promise<StepTemplate[]> {
    return this.repository.listByUser(userId);
  }

  async get(id: string, userId: string): Promise<StepTemplate> {
    const template = await this.repository.findById(id);
    if (!template || template.userId !== userId) {
      throw new NotFoundError('Step template not found');
    }
    return template;
  }

  async create(userId: string, input: { name: unknown; step: unknown }): Promise<StepTemplate> {
    const name = validateName(input.name);
    const step = validateAndNormalizeStep(input.step);
    const payload: CreateStepTemplateInput = { name, step };
    return this.repository.create(userId, payload);
  }

  async update(
    id: string,
    userId: string,
    input: { name?: unknown; step?: unknown },
  ): Promise<StepTemplate> {
    // Ownership check first (NotFound for others' templates).
    const existing = await this.repository.findById(id);
    if (!existing || existing.userId !== userId) {
      throw new NotFoundError('Step template not found');
    }

    const updates: UpdateStepTemplateInput = {};
    if (input.name !== undefined) {
      updates.name = validateName(input.name);
    }
    if (input.step !== undefined) {
      updates.step = validateAndNormalizeStep(input.step);
    }
    if (updates.name === undefined && updates.step === undefined) {
      throw new ValidationError('No updatable fields provided (name and/or step required)');
    }

    const updated = await this.repository.update(id, updates);
    // Should not happen (existence already verified), but guard defensively.
    if (!updated) {
      throw new NotFoundError('Step template not found');
    }
    return updated;
  }

  async delete(id: string, userId: string): Promise<void> {
    const existing = await this.repository.findById(id);
    if (!existing || existing.userId !== userId) {
      throw new NotFoundError('Step template not found');
    }
    await this.repository.delete(id);
  }
}
