# PLAN-055 — Step & Block Templates Design

> **Status: DESIGN ONLY.** No production code, schema, migration, API, or UI was
> created or modified for this document. Everything below labelled *Recommendation*
> or *Proposed* is a proposal for future PLAN tasks, not existing behavior.
>
> **Legend used throughout:**
> - **[FACT]** — verified in the current codebase (with file references).
> - **[REQ]** — follows directly from the PLAN-055 product decisions.
> - **[REC]** — my recommendation / proposed design.
> - **[UNKNOWN]** — could not be determined from the codebase; flagged as open.

---

## 1. Executive Summary

Watt Locker needs user-owned **Step Templates** (a single reusable step) and
**Block Templates** (a reusable, optionally-repeating group of steps). When
inserted into an activity they must **materialize** — copy their data into the
activity's existing step structure and then have no further link to the template.

**Key finding [FACT]:** the canonical structured-workout representation is a flat
array of steps called `segments` stored as **opaque embedded JSON** on the
`workouts` MongoDB document. A "step" is the UI-side `PlanSegment` type; a "block"
is *not* a distinct entity — it is a run of contiguous `segments` sharing a
`repeatId` + `repeatCount` (PLAN-046 "Option B"). The existing "Template Library"
is a **whole-activity** snapshot (`template: true` flag on a `workouts` doc), a
different granularity from step/block templates.

**Core recommendation [REC]:** introduce Step Templates and Block Templates as
**new, separate user-owned entities** (their own Mongo collections + repositories
+ routes), *not* by overloading the `template` boolean on `workouts`. A template's
payload reuses the **exact `PlanSegment` shape** already used by the planner, so
materialization is simply "produce `PlanSegment[]` and append to the activity's
`segments` array (assigning a fresh `repeatId`/`repeatCount` for blocks)."
Because the output is ordinary `segments`, the result is **indistinguishable**
from a hand-built activity — which is exactly what downstream adapters (e.g. a
future Garmin adapter) require.

This preserves the canonical model, avoids a parallel workout representation, and
fits the existing "materialize by copy" pattern already used by the whole-activity
template copy endpoint.

---

## 2. Existing Architecture Findings

### 2.1 Activity [FACT]
- The canonical Activity is `WorkoutRecord` — `watt-locker-api/src/models/workout.ts:28-142`.
- Persisted as a single document in the Mongo `workouts` collection; DB shape is
  `WorkoutDocument` — `watt-locker-api/src/repositories/workoutRepository.ts:34-97`.
- DB is **MongoDB** (mongodb v6 driver; `src/config/database.ts`, `package.json`).
- "Activity" and "Workout" are the same entity (product name vs code name).

### 2.2 Activity Step [FACT]
- There is **no server-side Step type**. Steps live only inside the opaque
  `segments?: unknown[]` field on the workout doc (`workout.ts:95`,
  `workoutRepository.ts:86`). The server never validates or inspects `segments`;
  it is written/read via `as any` passthrough (`workoutRepository.ts:229, 424, 763`).
- The step *shape* is defined UI-side as `PlanSegment` —
  `watt-locker-ui/src/utils/tssCalculator.ts:16-33`:
  ```ts
  export type IntensityMetric = 'power_ftp' | 'hr_threshold' | 'hr_max' | 'power_watts';

  export interface PlanSegment {
    type: 'warmup' | 'interval' | 'recovery' | 'cooldown' | 'steady';
    durationSeconds: number;
    intensityMetric?: IntensityMetric; // per-step override of the activity metric
    powerMin?: number;   // % FTP when metric is power_ftp; watts when power_watts
    powerMax?: number;
    hrMin?: number;
    hrMax?: number;
    cadenceMin?: number;
    cadenceMax?: number;
    notes?: string;
    repeatId?: string;   // PLAN-046 block grouping
    repeatCount?: number;// authoritative on the first child of the run
  }
  ```
- **[FACT]** A step today is **duration-based only** (`durationSeconds`). There is
  no per-step distance field. (Distance exists only at activity level as
  `plannedDistanceMeters`.)
- **[FACT]** A step has **no name/label** field and **no id** field.
- **[FACT]** Targets are **min/max ranges** per metric (power/HR/cadence), never a
  single value + tolerance.

### 2.3 Activity Block / Repeat [FACT]
- A "block" is **not** an entity. Per PLAN-046 ("Option B"), a repeat block is a
  run of **contiguous** `segments` that share a `repeatId`, with `repeatCount` on
  the first child being authoritative.
- Rendering grouping: `buildRenderRows(segments)` in `PlanActivityPage.tsx:125-151`
  collapses contiguous same-`repeatId` runs into a `RenderRow` of kind `'repeat'`.
- Execution expansion: `expandSegments(segments)` in `tssCalculator.ts:44` emits
  the run `repeatCount` times (stripping repeat metadata from copies). This is the
  *only* place expansion happens.
- **[FACT]** Blocks cannot nest — the model is a flat array with single-level
  contiguous grouping. This aligns with the product decision that blocks cannot
  contain blocks.

### 2.4 Existing Template infrastructure [FACT]
- A "template" today = an entire Activity with `template: true`, `status: null`,
  `date: null` on the same `workouts` collection. There is **no** separate
  templates model/collection/repository.
- Routes (all in `watt-locker-api/src/routes/workouts.ts`):
  - `GET /api/workouts/templates` — list (`workoutService.listWorkouts` with `template:true`).
  - `POST /api/workouts/templates` — create a whole-activity template (allowlist of planning fields).
  - `POST /api/workouts/templates/:id/copy` — **materialize** template → planned activity for a `date`.
  - `POST /api/workouts/:id/save-as-template` — activity → template.
  - `PUT /api/workouts/:id` — forbids changing `status`/`template` flag.
- **[FACT] Smell:** the copy and save-as-template handlers reach into the raw
  Mongo doc via `(workoutRepository as any).workouts.findOne(...)` to copy
  `segments`/targets/equipment/`referenceMetric`, because those fields are not
  first-class on `WorkoutRecord`. `createTemplate()` in the repository is a
  misnamed generic insert used for both template creation and template→activity copy.
- **[FACT]** The existing whole-activity template **already demonstrates the
  "materialize by copy" pattern** we want for step/block templates, and confirms
  the canonical model expects templates to produce ordinary activity data.

### 2.5 Planner UI [FACT]
- The **entire** planner/editor is one file: `watt-locker-ui/src/pages/PlanActivityPage.tsx`
  (~1341 lines). There are **no** extracted `StepEditor` / `RepeatEditor` /
  `SegmentList` components. This is the single biggest UI-reuse constraint.
- Relevant in-file primitives:
  - State `segments: PlanSegment[]` (`PlanActivityPage.tsx:192`).
  - `createEmptySegment(type='interval')` → `{type, durationSeconds:300, ...}` (`:99-102`).
  - `generateRepeatId()` (crypto.randomUUID w/ fallback) (`:105-112`).
  - `buildRenderRows(segments)` grouping (`:125-151`).
  - Repeat-block builder state: `repeatStart`, `repeatEnd`, `repeatCount` (`:195-197`).
- **Template mode** is detected by route path: `location.pathname.startsWith('/templates')`
  (`:162`). `/templates/new` and `/templates/:id/edit` both render `PlanActivityPage`
  (`watt-locker-ui/src/App.tsx`).
- **"Use Template"** (`TemplateLibraryPage.tsx`) deep-copies the template object and
  navigates to `/activities/plan` passing it via `location.state.template`; a
  `useEffect` in `PlanActivityPage.tsx:248+` populates the form + `segments` from it.
  **This is a client-side materialization that already exists** for whole-activity
  templates and is the natural hook point for step/block insertion.

### 2.6 API [FACT]
- All workout/template routes are under `/api/workouts` and mounted behind JWT auth
  (`router.use(authMiddleware)`); handlers read `req.user!.userId`.
- Validation is manual/inline in the route handlers (type checks + `ValidationError`).
  `zod` is available as a dependency but the workout routes largely hand-roll checks.
- Service boundary: `WorkoutService` enforces ownership (`workout.userId !== userId`
  → `NotFoundError`); repository does raw Mongo. Routes → Service → Repository.

### 2.7 Persistence [FACT]
- Single `workouts` collection for activities + whole-activity templates; a
  `metrics` time-series collection for completed per-second data.
- Indexes created programmatically (`workoutRepository.ts:159-172`):
  `{userId,startTime:-1}`, unique partial `{userId,sourceActivityId}`,
  `{userId,date,status}`, `{userId,template}`. No index anticipates step/block reuse.
- User ownership: plain `userId: string` on every doc; enforced in the service layer,
  not the DB. Same pattern for `users`, `settings`, `sourceArtifacts`.
- Migrations live in `src/migrations/`; only lifecycle/backfill migrations exist
  (`003-backfill-status-template-date.ts`, `020-backfill-source-artifacts.ts`).

### 2.8 Intensity / % FTP resolution [FACT]
- `IntensityMetric = 'power_ftp' | 'hr_threshold' | 'hr_max' | 'power_watts'`.
- For `power_ftp`, `powerMin/Max` are **percentages** and are resolved to watts
  **lazily at calc/display time** via `getSegmentAvgPowerWatts(segment, ftp, activityMetric)`
  (`tssCalculator.ts:114-142`); `power_watts` are literal watts; `hr_*` use HR ranges.
- Planning FTP is resolved UI-side by `resolvePlanningFtp(activityFtpOverride, ftpHistory)`
  (`tssCalculator.ts`), with `ftpHistory` from user settings
  (`UserSettings.ftpHistory` — `settings.ts`).
- **[FACT]** There is **no server-side %FTP→watts resolution** for planned targets;
  the percentage is stored and resolved only when displayed/calculated. `lookupFtp()`
  (`utils/ftpLookup.ts`) resolves FTP by date but is used **only** for completed-workout
  TSS/IF recalculation, not planning.
- **[FACT]** There is **no HR-threshold history** equivalent to FTP history.

---

## 3. Current Canonical Activity Model

*(All [FACT].)* A planned Activity is a `workouts` document:

```
WorkoutDocument (Mongo 'workouts')
├── userId: string                 // owner
├── status: 'planned'|'completed'|'skipped'|null
├── template: boolean              // true => whole-activity template
├── date: 'YYYY-MM-DD' | null
├── activityType: string           // e.g. 'ride'
├── plannedDurationSeconds?, plannedDistanceMeters?, plannedTss?, plannedIf?
├── targetPowerMin/Max?, targetHrMin/Max?, targetCadenceMin/Max?, targetSpeed?  // activity-level
├── referenceMetric?: { type: string; value: number }
├── segments?: unknown[]           // <-- THE structured workout: PlanSegment[] as opaque JSON
└── ... (actual/summary metrics for completed activities)
```

The structured workout is the ordered `segments` array. Order = array position.
A repeat block = a contiguous run of segments sharing `repeatId` (count on the
first child). Steps are duration-based, target ranges per metric, `power_ftp`
values are % FTP resolved lazily. The server stores `segments` verbatim; all
structural semantics live in the UI (`tssCalculator.ts`, `PlanActivityPage.tsx`).

---

## 4. Template Model Recommendation

Granularity mismatch [FACT]: the existing whole-activity template carries an
activity surface (activityType, status, date, planned totals, lifecycle) that a
single step or a block does not have. Overloading `workouts` with step/block rows
would require a mostly-empty, semantically-wrong document and special-casing in
every workout query (list filters, calendar exclusion, skip evaluation, mappers).

**[REC] Introduce two new user-owned entities** (siblings of the existing
whole-activity template), each in its own Mongo collection:

### 4.1 Step Template *(Proposed)*
Represents one reusable step. Payload reuses the `PlanSegment` shape (minus block
metadata).

```
StepTemplate (Proposed, collection 'step_templates')
├── _id
├── userId: string                 // owner (same pattern as workouts)
├── name: string                   // e.g. "Sweet Spot"  (NEW: PlanSegment has no name today)
├── step: {                        // reuses PlanSegment fields (no repeatId/repeatCount)
│     type: 'warmup'|'interval'|'recovery'|'cooldown'|'steady';
│     durationSeconds: number;     // OR future distance (see §12 open question)
│     intensityMetric?: IntensityMetric;
│     powerMin?/powerMax?/hrMin?/hrMax?/cadenceMin?/cadenceMax?: number;
│     notes?: string;
│   }
├── createdAt, updatedAt
```

### 4.2 Block Template *(Proposed)*
Represents a reusable group of steps with an optional default repeat count.

```
BlockTemplate (Proposed, collection 'block_templates')
├── _id
├── userId: string
├── name: string                   // e.g. "Sweet Spot Block"
├── defaultRepeatCount: number     // default block repeat (>=1); [REQ] block may define a default
├── steps: BlockTemplateStep[]     // ordered; [REQ] a block consists of steps, never blocks
├── createdAt, updatedAt
```

### 4.3 Block Template Step *(Proposed)*
An embedded step inside a block template. Same shape as the Step Template `step`
payload; **embedded** (not a reference to a StepTemplate) so blocks are
self-contained and blueprint-independent [REQ #5].

```
BlockTemplateStep (Proposed, embedded)
= same fields as StepTemplate.step, plus an explicit order (array position)
```

### 4.4 User ownership & relationships [REC]
- Both entities carry `userId: string`, enforced in a service layer exactly like
  `WorkoutService` (`entity.userId !== userId → NotFoundError`). [REQ #7]
- No relationship from a Block Template to Step Templates: block steps are
  **embedded copies**, not references. This guarantees editing a Step Template
  never changes a Block Template, and neither changes any activity. [REQ #5, #6]
- No relationship from templates to activities: after insertion the activity holds
  plain `segments`; there is **no `templateId`/`isTemplate`/provenance** on the
  activity step/block. [REQ #5, #8] Inspection confirmed nothing in the current
  model requires provenance, so we deliberately omit it.

### 4.5 Constraints [REC/REQ]
- `BlockTemplate.steps.length >= 1`; `defaultRepeatCount` integer `>= 1`.
- Blocks may not contain blocks — enforced structurally (a `BlockTemplateStep` has
  no `steps`/`repeatId`). [REQ #3]
- Names are required and user-scoped; uniqueness is **not** required (a user may
  have two "Sweet Spot" steps) unless product wants otherwise — see §12.

---

## 5. Materialization / Insertion Design

**Owning layer [REC]:** materialization produces `PlanSegment[]` and is owned by a
small dedicated module. Given the current reality that all segment semantics live
in the UI, the **primary materializer runs client-side** in the planner (mirroring
the existing `location.state.template` copy path), producing `PlanSegment[]` that
are appended to `segments` and saved through the existing activity save path. An
**equivalent server-side materializer** is recommended if/when a server "insert
template into activity" endpoint is added (see §7), so both paths share one rule
set. Materialization must **not** live in any adapter.

### 5.1 Step insertion [REQ #5, §Materialization]
```
StepTemplate
  → copy step attributes into a new PlanSegment
  → apply insertion-time overrides (duration/distance, metric, targets)
  → assign array position (append or insert at index)
  → result: one ordinary PlanSegment in activity.segments
```

### 5.2 Block insertion [REQ #2, #3]
```
BlockTemplate
  → generate ONE fresh repeatId (generateRepeatId())
  → resolve repeatCount = override ?? defaultRepeatCount
  → for each BlockTemplateStep (in order):
        copy → new PlanSegment with the shared repeatId
        set repeatCount on the FIRST child (authoritative per PLAN-046)
        apply step-level overrides if provided
  → splice the run into activity.segments (contiguous, preserving order)
  → result: an ordinary contiguous repeat run — identical to a hand-built block
```

### 5.3 Overrides [REQ #4]
- Overrides apply to the **materialized activity structure only**; the template is
  never modified.
- Supported override targets: step `durationSeconds` (and distance if/when steps
  gain distance), `intensityMetric`, target ranges (power/HR/cadence), block
  `repeatCount`. [REQ #4 "including but not limited to"]
- **[REC]** In the request/payload, represent overrides as a sparse patch keyed by
  step index (for block) or a single patch (for step), applied after the copy:
  `{ repeatCount?, steps?: { [index]: Partial<PlanSegment> } }`.

### 5.4 Repeat counts [REQ #2]
- `defaultRepeatCount` seeds the block; insertion-time `repeatCount` overrides it;
  stored on the first child of the run (matches PLAN-046). `repeatCount` of 1 =
  a non-repeating group (still contiguous). Floor to integer `>= 1`.

### 5.5 Ordering [FACT/REC]
- Order is array position in `segments`. Insertion appends by default or splices at
  a chosen index. Block steps keep their relative order and stay contiguous
  (required for the `repeatId` grouping to render/expand correctly).

### 5.6 Validation [REC]
- Template CRUD: validate `name`, step `type` enum, positive `durationSeconds`,
  min ≤ max for any provided range, `intensityMetric` enum, `defaultRepeatCount`
  integer ≥ 1, `steps.length ≥ 1`. Reuse the existing manual-validation style in
  `routes/workouts.ts` (or introduce `zod` schemas — see §12).
- Materialized output must satisfy the same `PlanSegment` invariants the planner
  already relies on, so no new activity-side validation is required.

### 5.7 ID generation [FACT/REC]
- Template `_id`: Mongo `ObjectId` (as elsewhere).
- Block `repeatId` at insertion: `generateRepeatId()` (crypto.randomUUID) — the
  planner's existing helper. Steps themselves have no ids (unchanged).

### 5.8 Reference metrics / threshold-dependent targets [FACT/REQ #5]
- `power_ftp` targets are stored as **percentages** and resolved to watts lazily
  via the existing `getSegmentAvgPowerWatts`/`resolvePlanningFtp` path. Templates
  **store percentages** and are inserted as percentages — resolution continues to
  happen at display/calc using the *activity's* FTP context, not the template's.
  This preserves %FTP correctly and keeps the blueprint independent of any FTP.

---

## 6. Persistence / Database Design *(Proposed)*

### 6.1 Collections [REC]
- `step_templates` — one doc per Step Template (§4.1).
- `block_templates` — one doc per Block Template with embedded ordered `steps` (§4.2/4.3).
- Keep the existing whole-activity template mechanism (`template:true` on `workouts`)
  **unchanged**.

### 6.2 Relationships [REC]
- `userId` scopes both collections. No cross-references (block steps embedded).
- No FK from activity → template (blueprint independence).

### 6.3 Constraints / Indexes [REC]
- Index `{ userId: 1, name: 1 }` on each collection for library listing/search
  (mirrors the existing `{userId, template}` library index intent).
- Optional `{ userId: 1, updatedAt: -1 }` for recency ordering.
- Enforce structural constraints in the service/validation layer (Mongo has no
  schema enforcement here today).

### 6.4 Migration considerations [REC]
- **New collections require no migration** of existing data (empty on first use);
  indexes can be created in the same programmatic `createIndexes()` pattern.
- **No change** to the `workouts` schema, no change to `segments`, no backfill.
- *(Optional, separate future task — NOT part of this feature):* the "reach into
  raw Mongo doc" smell for `segments`/targets could be cleaned by typing `segments`
  as `PlanSegment[]` on `WorkoutRecord`. Documented under §12; **do not** bundle it
  into template work.

---

## 7. API Design *(Proposed)*

Follow existing conventions: JWT auth, `req.user.userId`, `successResponse`
envelope, service-layer ownership, pagination like the templates list.

### 7.1 Step Template CRUD [REC]
- `GET  /api/step-templates` — list (paginated, `search` by name).
- `POST /api/step-templates` — create `{ name, step:{…} }`.
- `GET  /api/step-templates/:id` — read (owner-scoped).
- `PUT  /api/step-templates/:id` — update name/step.
- `DELETE /api/step-templates/:id` — delete.

### 7.2 Block Template CRUD [REC]
- `GET  /api/block-templates`
- `POST /api/block-templates` — `{ name, defaultRepeatCount, steps:[…] }`.
- `GET  /api/block-templates/:id`
- `PUT  /api/block-templates/:id`
- `DELETE /api/block-templates/:id`

*(Route base path `/api/step-templates` / `/api/block-templates` [REC]; could also
be nested under `/api/templates/steps` etc. — cosmetic.)*

### 7.3 Insert / materialize operation [REC] — **prefer reusing existing activity mutation**
Because materialization yields plain `segments`, insertion **should reuse the
existing activity save/update path** rather than a bespoke server endpoint:
- Client builds the `PlanSegment[]` from the template (+overrides), appends to the
  planner's `segments`, and saves via the existing `createActivity`/`updateWorkout`
  (`PUT /api/workouts/:id`) flow. This mirrors the current whole-activity "Use
  Template" behavior and requires **no new activity endpoint**.
- **[REC, optional]** If a server-authoritative insert is later desired, add
  `POST /api/workouts/:id/insert-template` `{ kind:'step'|'block', templateId, index?, overrides? }`
  that runs the shared server materializer and appends to `segments`. Treat as
  optional; the request payload for overrides is the sparse patch from §5.3.

### 7.4 Validation & authorization [REC]
- Validate per §5.6. Scope every read/write by `userId`; return `NotFoundError`
  (not 403) for other users' templates, matching `WorkoutService`. [REQ #7]

### 7.5 Response concepts [REC]
- Template responses return the stored template (id, name, step/steps, defaults).
- Insertion returns the **updated Activity** (ordinary `segments`), so the client
  re-renders with no template-specific fields.

---

## 8. UI Design *(Proposed)*

### 8.1 Template Library [REC]
- Extend the existing Template Library concept to show three sections:
  Activities (existing), Steps, Blocks. Could be tabs within `TemplateLibraryPage`
  or a sibling library view. Reuse the existing card/search/pagination/delete UX.

### 8.2 Step Template editor [REC]
- A small form: name + the same fields the planner uses for one step (type,
  duration, intensity metric, target ranges, notes). See §9 for the reuse caveat.

### 8.3 Block Template editor [REC]
- Name + default repeat count + an ordered list of step editors + add/remove/reorder.
  This is essentially the planner's segment-list minus activity-level fields.

### 8.4 Planner side tray [REQ #9]
- A collapsible right-hand tray inside `PlanActivityPage` listing the user's Step
  and Block templates (fetched via the new list endpoints), with insert affordances
  (click / drag). No navigation away from the editor.

### 8.5 Insertion flow [REQ #9, #4]
- Insert appends (or drops at an index) into the existing `segments` state using
  the in-file primitives (`createEmptySegment` analog, `generateRepeatId`,
  `buildRenderRows`). No second editor: after insertion the new step(s)/block are
  ordinary rows editable by the **existing** inline step/repeat editing UI, which
  is exactly how insertion-time overrides are supported. [REQ #4, #8]

### 8.6 Insertion-time editing/overrides [REQ #4]
- Because the inserted rows are ordinary `segments`, overrides = the user editing
  those rows in place with the existing controls. Optionally, a lightweight
  "insert with overrides" mini-form can pre-fill before inserting, but the simplest
  correct approach is insert-then-edit-in-place. Either way, the template is untouched.

---

## 9. Existing Component Reuse

**Reuse (exists today) [FACT]:**
- `PlanSegment` + `IntensityMetric` types (`tssCalculator.ts`) — the step payload
  shape for both template kinds. **Reuse verbatim.**
- `expandSegments`, `getSegmentAvgPowerWatts`, `calculateSegmentTss`,
  `resolvePlanningFtp` (`tssCalculator.ts`) — no changes; materialized segments
  flow through them unchanged.
- Planner primitives in `PlanActivityPage.tsx`: `createEmptySegment`,
  `generateRepeatId`, `buildRenderRows`, the `segments` state and its inline
  step/repeat editing UI — the insertion target and the "override in place" editor.
- Existing library UX patterns in `TemplateLibraryPage.tsx` (cards, search,
  pagination, delete) and API-client/envelope conventions in `api/workouts.ts`.
- API conventions: JWT auth, `successResponse`, service-layer ownership, the
  paginated list style used by `GET /workouts/templates`.

**Genuinely new [REC]:**
- API: `StepTemplate`/`BlockTemplate` models, repositories, services, routes, and
  their indexes; (optional) a shared materializer module.
- UI: step-template editor, block-template editor, the planner **side tray**, and
  API-client methods (`listStepTemplates`, `createStepTemplate`, … block equivalents).

**Reuse caveat [FACT/REC]:** the planner is one 1341-line file with **no extracted
step/repeat editor components**. The side tray and the standalone step/block editors
would benefit from extracting a `StepEditor`/`RepeatEditor` from `PlanActivityPage`.
This extraction is a **recommended prerequisite refactor** (see §13) but is **not
strictly required** — insertion can operate purely on the `segments` array and let
the existing inline editor handle overrides. Flag: duplicating the step-editing UI
instead of extracting it would create drift risk.

---

## 10. Architectural Boundaries

- **Belongs to templates:** the `step_templates`/`block_templates` collections,
  their CRUD, the library UI, the side tray, and the materialization rules.
- **Remains canonical Activity functionality:** the `segments` array, repeat-block
  grouping/expansion, %FTP resolution, TSS/IF math, activity save/update. Templates
  produce inputs to this; they do not extend or alter it.
- **Must NOT leak into Garmin/adapters:** no template identity, no `templateId`, no
  block-template repeat semantics beyond the ordinary `repeatId`/`repeatCount`, and
  no template-specific serialization. Adapters consume canonical
  Activity/Step/Block only. [REQ #8, Garmin section]

---

## 11. Alternatives Considered

1. **Extend the `template` boolean on `workouts` (reuse whole-activity template).**
   Rejected [REC]: wrong granularity; a step/block is not an activity. Would force a
   near-empty activity doc and special-casing across all workout queries
   (list/calendar/skip/mappers) and the single `{userId,template}` index.
2. **Reference-based blocks (Block Template referencing Step Templates by id).**
   Rejected [REC]: violates blueprint independence [REQ #5/#6] — editing a Step
   Template would ripple into blocks (and materialization would need live lookups).
   Embedded copies keep templates self-contained.
3. **A generic "template workout" model / second step+block schema.** Rejected
   [REQ constraint]: that is a parallel workout model. We reuse `PlanSegment`.
4. **Server-authoritative insert endpoint as the primary path.** Deferred [REC]:
   the existing client-side "Use Template" copy path already materializes into
   `segments`; a server insert endpoint is optional and can be added later sharing
   one materializer. Chosen primary path = reuse existing activity save.
5. **Single unified `templates` collection with a `kind` discriminator
   (`activity|step|block`).** Reasonable alternative [REC]; two collections chosen
   for clearer indexes/validation, but a discriminated single collection is
   acceptable if the team prefers one collection. Either fits the conventions.

---

## 12. Risks / Open Questions

1. **Step distance support [UNKNOWN/REQ].** The product decision lists "Duration OR
   distance," but `PlanSegment` today is **duration-only** (no per-step distance).
   Adding per-step distance is a change to the canonical step model beyond templates.
   *Open:* do Step Templates need distance in MVP? If yes, per-step distance must be
   added to `PlanSegment` first (separate task) so templates and hand-built steps stay
   identical. If no, scope Step Templates to duration for MVP.
2. **Step name/label on the canonical step [FACT].** `PlanSegment` has no `name`.
   Templates need a name for the *template*, but do inserted steps need to carry a
   label into the activity? Current model has no step label. *Open:* keep the name on
   the template only (recommended) vs. add an optional `label` to `PlanSegment`.
3. **Validation style [FACT].** Workout routes hand-roll validation; `zod` exists but
   is under-used there. *Open:* adopt `zod` for the new template routes (recommended)
   vs. match the existing manual style for consistency.
4. **Library UX shape [UNKNOWN].** Tabs in `TemplateLibraryPage` vs. separate views
   — product/design decision, not determined by code.
5. **Name uniqueness [UNKNOWN].** Whether template names must be unique per user.
6. **HR-threshold targets [FACT].** `hr_threshold`/`hr_max` metrics exist but there is
   no HR-threshold history (unlike FTP). Templates can store HR ranges, but resolution
   context for HR is weaker than FTP. Not a blocker; note for HR-based templates.

*(No manufactured questions: repeat semantics, blueprint independence, ownership,
non-nesting, and no-provenance are all settled by the requirements.)*

### Implementation Prerequisites (do NOT fix now)
- **(Recommended)** Extract `StepEditor`/`RepeatEditor` from `PlanActivityPage.tsx`
  so the side tray and the step/block editors reuse one editor (avoids UI drift).
- **(Optional cleanup, separate task)** Type `segments` as `PlanSegment[]` on
  `WorkoutRecord` and remove the `(repo as any).workouts.findOne` reach-throughs in
  the copy/save-as-template handlers. Not required for templates; documented only.

---

## 13. Recommended Implementation Sequence *(future PLAN tasks — do not implement now)*

- **PLAN-056 (API):** `StepTemplate` + `BlockTemplate` models, repositories, services
  (ownership), routes (CRUD), indexes, validation, tests. New collections only; no
  `workouts` changes.
- **PLAN-057 (UI editors):** Step Template editor + Block Template editor + API client
  methods + library section. *(Optional prerequisite: extract `StepEditor`/`RepeatEditor`
  from `PlanActivityPage`.)*
- **PLAN-058 (Planner side tray + insertion/materialization):** collapsible tray in
  `PlanActivityPage`, client-side materializer producing `PlanSegment[]`, insert +
  in-place override, save via existing activity path.
- **PLAN-059 (optional):** server-side `insert-template` endpoint + shared server
  materializer, if server-authoritative insertion is wanted.
- **PLAN-060 (optional):** distance-per-step and/or step `label` on the canonical
  model, only if MVP requires them (gated by §12.1/§12.2).

---

## 14. Definition of Done for PLAN-055

- [x] Existing Activity/Step/Block model, persistence, API, planner UI, and existing
      Template Library inspected with concrete file references.
- [x] Recommendation on how to introduce Step & Block Templates while preserving the
      canonical model (new sibling entities; materialize into `segments`).
- [x] Materialization/insertion, overrides, repeat, ordering, ID, and %FTP handling
      designed explicitly.
- [x] Persistence, API, and UI designs proposed; reuse vs. new clearly separated.
- [x] Garmin compatibility evaluated (adapters see only canonical Activity; no template
      leakage).
- [x] Alternatives, risks, prerequisites, and a future PLAN sequence documented.
- [x] Facts vs. requirements vs. recommendations distinguished throughout.
- [x] No production code, schema, migration, API, or UI changed.

---

## Appendix — Garmin Compatibility Evaluation

**Requirement:** template insertion output must be indistinguishable from a
manually-created structured activity to downstream adapters. [REQ, Garmin section]

- The materializer emits **ordinary `PlanSegment[]`** into `segments` with standard
  `repeatId`/`repeatCount` grouping — the same structure a hand-built activity has.
  A future Garmin adapter consumes the canonical Activity/Step/Block and never sees
  a template. ✅
- The POC (PLAN-054) already proved Garmin accepts a genuine repeat group; our block
  materialization produces exactly that grouping, so no flattening is needed. ✅
- **Call-outs that could make Garmin harder (avoid):**
  - Do **not** add template identity/provenance (`templateId`, `isTemplate`) to
    activity steps/blocks — it would leak a template concept into the adapter. [REQ #8]
  - Keep %FTP resolution in the canonical layer (resolve against the *activity's* FTP),
    not baked into the template, so the adapter receives consistent watt/percentage
    semantics identical to hand-built activities.
  - Do not introduce template-specific serialization or a second block model; the
    adapter must have exactly one Activity/Step/Block shape to map.
