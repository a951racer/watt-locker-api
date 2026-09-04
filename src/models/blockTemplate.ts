/**
 * PLAN-058: Block Template domain model.
 *
 * A Block Template is a user-owned, reusable BLUEPRINT for an ordered group of
 * canonical Activity Steps, with a default repeat count. It is NOT an Activity,
 * an Activity Block, or a whole-Activity Template.
 *
 * Its steps are canonical `PlanSegment`s (from ./workout) — there is
 * deliberately NO second/duplicate step model and NO nested-block structure:
 * the step list is a flat, ordered array. A Block Template may be authored
 * using Step Templates, but each step is COPIED in (no `stepTemplateId`, no
 * live reference). There is likewise no relationship to any Activity created
 * from it later.
 */
import { PlanSegment } from './workout';

/** A user-owned Block Template record. */
export interface BlockTemplate {
  id: string;
  userId: string;
  /** Template name shown in the Template Library (required, distinct from any step's optional canonical name). */
  name: string;
  /** Default repeat count for the block (positive integer). May be overridden at future insertion time. */
  repeatCount: number;
  /** Ordered, flat list of canonical steps (no nested blocks). */
  steps: PlanSegment[];
  createdAt: Date;
  updatedAt: Date;
}

/** Fields accepted when creating a Block Template. */
export interface CreateBlockTemplateInput {
  name: string;
  repeatCount: number;
  steps: PlanSegment[];
}

/** Fields accepted when updating a Block Template (all optional). */
export interface UpdateBlockTemplateInput {
  name?: string;
  repeatCount?: number;
  steps?: PlanSegment[];
}

/** Maximum length for a template name (consistent with Step Templates). */
export const BLOCK_TEMPLATE_NAME_MAX_LENGTH = 120;

/** Sensible bounds for a block's default repeat count. */
export const BLOCK_TEMPLATE_MIN_REPEAT_COUNT = 1;
export const BLOCK_TEMPLATE_MAX_REPEAT_COUNT = 99;
