/**
 * Canonical Activity Step ("PlanSegment") validation + normalization.
 *
 * PLAN-057: The server previously treated `segments` as opaque JSON. Step
 * Templates need to validate and normalize a single canonical step before
 * persistence, so this module provides the smallest reusable canonical
 * validator/normalizer. It mirrors the UI rules established in PLAN-056
 * (watt-locker-ui/src/utils/tssCalculator.ts) so Activities and Templates
 * share ONE definition of a valid step.
 *
 * It intentionally does NOT introduce a second step type — it operates on the
 * canonical `PlanSegment` from ../models/workout.
 */
import { PlanSegment, StepDurationType, StepIntensityMetric } from '../models/workout';
import { ValidationError } from './errors';

export const STEP_TYPES = ['warmup', 'interval', 'recovery', 'cooldown', 'steady'] as const;
export const STEP_DURATION_TYPES: StepDurationType[] = ['time', 'distance'];
export const STEP_INTENSITY_METRICS: StepIntensityMetric[] = [
  'power_ftp',
  'hr_threshold',
  'hr_max',
  'power_watts',
];

/** Numeric range fields that must satisfy min <= max when both are present. */
const RANGE_PAIRS: Array<[keyof PlanSegment, keyof PlanSegment, string]> = [
  ['powerMin', 'powerMax', 'power'],
  ['hrMin', 'hrMax', 'hr'],
  ['cadenceMin', 'cadenceMax', 'cadence'],
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertOptionalNonNegativeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative number`, { field });
  }
  return value;
}

/**
 * Validate a single canonical step and return a NORMALIZED copy that satisfies
 * the "exactly one duration" invariant (PLAN-056):
 *  - durationType 'time'     → durationSeconds present (> 0), distanceMeters removed
 *  - durationType 'distance' → distanceMeters present (> 0), durationSeconds removed
 *
 * Legacy input without an explicit durationType but with a positive
 * durationSeconds is treated as time. Contradictory input (both values, or a
 * value that contradicts the declared type) is normalized to the declared type
 * — the incompatible value is dropped rather than persisted.
 *
 * Throws ValidationError on structurally invalid input.
 */
export function validateAndNormalizeStep(input: unknown): PlanSegment {
  if (!isPlainObject(input)) {
    throw new ValidationError('step must be an object', { field: 'step' });
  }

  const raw = input as Record<string, unknown>;

  // type (required, enum)
  const type = raw.type;
  if (typeof type !== 'string' || !(STEP_TYPES as readonly string[]).includes(type)) {
    throw new ValidationError(
      `step.type must be one of: ${STEP_TYPES.join(', ')}`,
      { field: 'step.type' },
    );
  }

  // name (optional string)
  let name: string | undefined;
  if (raw.name !== undefined && raw.name !== null) {
    if (typeof raw.name !== 'string') {
      throw new ValidationError('step.name must be a string', { field: 'step.name' });
    }
    const trimmed = raw.name.trim();
    name = trimmed === '' ? undefined : trimmed;
  }

  // intensityMetric (optional, enum)
  let intensityMetric: StepIntensityMetric | undefined;
  if (raw.intensityMetric !== undefined && raw.intensityMetric !== null && raw.intensityMetric !== '') {
    if (
      typeof raw.intensityMetric !== 'string' ||
      !(STEP_INTENSITY_METRICS as string[]).includes(raw.intensityMetric)
    ) {
      throw new ValidationError(
        `step.intensityMetric must be one of: ${STEP_INTENSITY_METRICS.join(', ')}`,
        { field: 'step.intensityMetric' },
      );
    }
    intensityMetric = raw.intensityMetric as StepIntensityMetric;
  }

  // notes (optional string)
  let notes: string | undefined;
  if (raw.notes !== undefined && raw.notes !== null) {
    if (typeof raw.notes !== 'string') {
      throw new ValidationError('step.notes must be a string', { field: 'step.notes' });
    }
    const trimmed = raw.notes.trim();
    notes = trimmed === '' ? undefined : raw.notes;
  }

  // Numeric target fields (optional, non-negative)
  const powerMin = assertOptionalNonNegativeNumber(raw.powerMin, 'step.powerMin');
  const powerMax = assertOptionalNonNegativeNumber(raw.powerMax, 'step.powerMax');
  const hrMin = assertOptionalNonNegativeNumber(raw.hrMin, 'step.hrMin');
  const hrMax = assertOptionalNonNegativeNumber(raw.hrMax, 'step.hrMax');
  const cadenceMin = assertOptionalNonNegativeNumber(raw.cadenceMin, 'step.cadenceMin');
  const cadenceMax = assertOptionalNonNegativeNumber(raw.cadenceMax, 'step.cadenceMax');

  const candidate: PlanSegment = {
    ...(name !== undefined ? { name } : {}),
    type: type as PlanSegment['type'],
    ...(intensityMetric !== undefined ? { intensityMetric } : {}),
    ...(powerMin !== undefined ? { powerMin } : {}),
    ...(powerMax !== undefined ? { powerMax } : {}),
    ...(hrMin !== undefined ? { hrMin } : {}),
    ...(hrMax !== undefined ? { hrMax } : {}),
    ...(cadenceMin !== undefined ? { cadenceMin } : {}),
    ...(cadenceMax !== undefined ? { cadenceMax } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };

  // Range validation (min <= max where both present)
  for (const [minKey, maxKey, label] of RANGE_PAIRS) {
    const min = candidate[minKey] as number | undefined;
    const max = candidate[maxKey] as number | undefined;
    if (typeof min === 'number' && typeof max === 'number' && min > max) {
      throw new ValidationError(`step.${String(minKey)} must be <= step.${String(maxKey)}`, {
        field: `step.${label}`,
      });
    }
  }

  // --- Duration: exactly one of time/distance ---
  let durationType = raw.durationType;
  if (durationType !== undefined && durationType !== null) {
    if (typeof durationType !== 'string' || !(STEP_DURATION_TYPES as string[]).includes(durationType)) {
      throw new ValidationError(
        `step.durationType must be one of: ${STEP_DURATION_TYPES.join(', ')}`,
        { field: 'step.durationType' },
      );
    }
  } else {
    durationType = undefined;
  }

  const durationSeconds = assertOptionalNonNegativeNumber(raw.durationSeconds, 'step.durationSeconds');
  const distanceMeters = assertOptionalNonNegativeNumber(raw.distanceMeters, 'step.distanceMeters');

  // Resolve the effective duration type (explicit wins; else infer; else time).
  const resolvedType: StepDurationType =
    durationType === 'distance' || durationType === 'time'
      ? (durationType as StepDurationType)
      : (durationSeconds === undefined && distanceMeters !== undefined && distanceMeters > 0
          ? 'distance'
          : 'time');

  if (resolvedType === 'time') {
    if (durationSeconds === undefined || durationSeconds <= 0) {
      throw new ValidationError('time-based step requires a positive step.durationSeconds', {
        field: 'step.durationSeconds',
      });
    }
    // Normalize: keep time, drop distance.
    return { ...candidate, durationType: 'time', durationSeconds };
  }

  // distance
  if (distanceMeters === undefined || distanceMeters <= 0) {
    throw new ValidationError('distance-based step requires a positive step.distanceMeters', {
      field: 'step.distanceMeters',
    });
  }
  // Normalize: keep distance, drop time.
  return { ...candidate, durationType: 'distance', distanceMeters };
}
