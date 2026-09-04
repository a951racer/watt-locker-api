/**
 * PLAN-057: Step Template domain model.
 *
 * A Step Template is a user-owned, reusable BLUEPRINT for a single canonical
 * Activity Step. It is NOT an Activity, an Activity Step, or a whole-Activity
 * Template — it is a distinct entity with its own persistence.
 *
 * The reusable step definition is the canonical `PlanSegment` (from
 * ./workout) — there is deliberately no second/duplicate step model. Only
 * template-level identity/metadata (id, name, ownership, timestamps) is added
 * around it.
 *
 * There is intentionally NO relationship between a Step Template and any
 * Activity Step created from it: insertion/materialization (a future PLAN task)
 * copies the canonical step into the Activity, after which the Activity owns an
 * independent step.
 */
import { PlanSegment } from './workout';

/** A user-owned Step Template record. */
export interface StepTemplate {
  id: string;
  userId: string;
  /** Template name shown in the Template Library (required, distinct from the step's optional canonical name). */
  name: string;
  /** Canonical step definition (reused PlanSegment; no template-specific step type). */
  step: PlanSegment;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields accepted when creating a Step Template. */
export interface CreateStepTemplateInput {
  name: string;
  step: PlanSegment;
}

/** Fields accepted when updating a Step Template (all optional). */
export interface UpdateStepTemplateInput {
  name?: string;
  step?: PlanSegment;
}

/** Maximum length for a template name (consistent with typical title fields). */
export const STEP_TEMPLATE_NAME_MAX_LENGTH = 120;
