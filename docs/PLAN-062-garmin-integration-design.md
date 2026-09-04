# PLAN-062 — Garmin Integration Architecture & Adapter Design

> **Status: DESIGN ONLY.** No production code, schema, migration, route, UI, or
> dependency was created or changed for this document. Everything labelled
> *Proposed* / *Recommendation* is a proposal for later PLAN tasks.
>
> **Legend:** **[FACT]** verified in the current codebase (file refs given) ·
> **[POC]** established by the PLAN-053/054 Garmin proof-of-concept ·
> **[REC]** my recommendation · **[OPEN]** decision needing approval.

---

## 1. Executive Summary

Watt Locker owns the canonical athletic data model; Garmin Connect is an
**external projection** reached through an adapter. The production design places
a strict boundary between the Garmin-agnostic core (planner, `WorkoutRecord`,
`PlanSegment`, templates, TSS/IF) and Garmin, with three separable layers inside
the boundary: a **translator** (canonical → Garmin payload, pure/offline), a
**client/transport** (talks to Garmin Connect, owns auth), and an **adapter/
service** (coordinates lifecycle, maps to canonical results).

The single most important recommendation: **keep all Garmin state out of the
canonical `WorkoutRecord`.** Watt Locker already has the right precedent — the
`sourceArtifact` collection stores *inbound* provenance as a separate record
associated to an activity by `activityId` [FACT]. The mirror for *outbound* sync
is a new **`activityIntegrations`** record (external identity + sync state),
generic enough to support future platforms, never a `garminId` field on the
activity.

The unofficial Garmin Connect API is the primary path (validated end-to-end by
the POC), with the official FIT SDK as a documented fallback. The adapter
boundary is what makes that risk survivable: a Garmin backend change is a
localized client/translator fix, never a core-domain or schema change.

---

## 2. Existing Architecture Findings [FACT]

Verified in `watt-locker-api/src` (and the UI where noted).

### Canonical model
- **Activity = `WorkoutRecord`** (`models/workout.ts`): identity is the Mongo
  `_id` hex string (`id`); lifecycle is `status: 'planned'|'completed'|'skipped'|null`,
  `template: boolean`, `date: 'YYYY-MM-DD'|null`; ownership is a plain
  `userId: string`. Structured steps live in `segments?: PlanSegment[]`
  (embedded JSON; PLAN-056 typed it). Activity-level planned fields:
  `plannedDurationSeconds`, `plannedDistanceMeters`, `plannedTss`, `plannedIf`,
  target ranges, `referenceMetric?: {type,value}`.
- **`PlanSegment`** (defined UI-side `utils/tssCalculator.ts`, mirrored API-side
  `models/workout.ts`): `name?`, `type` (`warmup|interval|recovery|cooldown|steady`),
  `durationType?: 'time'|'distance'` with `durationSeconds?`/`distanceMeters?`
  (exactly one — PLAN-056), `intensityMetric?: 'power_ftp'|'hr_threshold'|'hr_max'|'power_watts'`,
  `powerMin/Max`, `hrMin/Max`, `cadenceMin/Max`, `notes?`, and repeat metadata
  `repeatId?`/`repeatCount?`.
- **Repeat blocks (PLAN-046 "Option B")**: a block is a contiguous run of
  segments sharing a `repeatId`, with `repeatCount` on each child (first child
  authoritative). Expanded only in `expandSegments()`; there is no nested block
  structure. PLAN-061 made reordering treat a block as one atomic top-level unit.
- **%FTP is a Watt Locker concept** [FACT]: for `power_ftp`, `powerMin/Max` are
  **percentages**, resolved to watts lazily at display/calc time via
  `getSegmentAvgPowerWatts()`/`resolvePlanningFtp()`; FTP comes from
  `UserSettings.ftpHistory`. Planned targets are **not** resolved to watts on the
  server today.

### Provenance / external-identity precedent
- **`sourceArtifact`** (`repositories/sourceArtifactRepository.ts`): a **separate
  collection**, not fields on the workout. Each record has `userId`, `source:
  'manual'|'strava'|'garmin'|'trainingpeaks'`, `format`, `sourceActivityId?`
  (the external id), and `activityId: string|null` associating it to the
  canonical activity, plus state (`materialized`, timestamps). **This is exactly
  the "integration state lives outside the Activity" pattern** the outbound design
  should mirror. `garmin` is already a recognized source value.
- **`DataSource = 'manual'|'strava'|'trainingpeaks'|'garmin'`** (`models/workout.ts`)
  — Garmin is already a first-class provider enum value.

### Connected sources / credentials precedent
- **`UserSettings.connectedSources: ConnectedSource[]`** (`models/settings.ts`):
  `{ provider: DataSource, connected: boolean, connectedAt?, oauthTokenEncrypted? }`.
  This is the established **per-user encrypted credential** pattern. Garmin auth
  state should follow this shape (per-user, encrypted), not a token file.

### Integration / adapter patterns already in the codebase
- **Strava** is the closest existing external-provider integration: OAuth routes
  mounted at `/api/auth/strava` (`createStravaRouter`), a `StravaSyncService`,
  and webhook routes. Config lives in `config/env.ts` under `config.strava`
  (`clientId/clientSecret/redirectUri/webhookVerifyToken`). **This is the
  provider-config + provider-service pattern to follow** for Garmin.
- **DI/layering** (`app.ts`): repositories → services → routers, wired in
  `createApp(deps)`; routers mounted under `/api/...` behind JWT auth
  (`router.use(authMiddleware)`); ownership enforced in services
  (`x.userId !== userId → NotFoundError`); responses use `successResponse`
  envelope; errors are typed (`ValidationError` 400 / `NotFoundError` 404 /
  `AuthenticationError` 401 / `ConflictError` 409 in `utils/errors.ts`).
- **`FileStorageAdapter`** (`storage/googleDriveAdapter.ts`) is a precedent for an
  **interface-typed adapter** injected into services with a no-op default — a
  good model for the Garmin client interface.
- Config pattern: providers get a namespaced block in `config/env.ts` fed by env
  vars (google, strava). Startup wires collections/indexes in
  `config/database.ts` → `initializeCollections`.

### Templates / materialization (Garmin-agnostic, must stay so)
- Step Templates (`stepTemplates`) and Block Templates (`blockTemplates`) are
  user-owned blueprints (PLAN-057/058) that **materialize by value** into
  canonical `segments` (PLAN-059) with **no template references** on the
  activity. The Garmin adapter must likewise leave no Garmin reference on the
  canonical activity.

---

## 3. Existing Garmin POC Findings [POC]

Location: a standalone `garmin-poc/` project **outside** both Watt Locker repos
(sibling directory). It is experimental research infra, deliberately not part of
production. Validated with a real Garmin account + Edge 1050 (PLAN-054).

- **Client:** Python `python-garminconnect` (`garminconnect` 0.3.11) + `curl_cffi`
  browser-TLS impersonation — the only current client that survives Garmin's
  March-2026 Cloudflare TLS/JA3 fingerprinting. It calls Garmin's **private HTTP
  API** directly (no browser, no scraping, no mobile app). This is an
  **unofficial / reverse-engineered** interface.
- **Auth:** interactive first login (email/password + MFA) persists a native DI
  OAuth2 token bundle (`di_token`, `di_refresh_token`, `di_client_id`) to a
  token store; subsequent runs authenticate **headlessly** from the tokens with
  proactive refresh. Observed transient **429 (Cloudflare/rate-limit)** on some
  mobile-login strategies before success.
- **Workout support (verified):** create structured cycling workout, upload,
  schedule for a date, and it appeared in Garmin Connect web + phone app.
  Repeat blocks preserved (Garmin accepts a genuine repeat group — no flattening
  needed), power targets and durations preserved.
- **Device delivery:** automatic background discovery did **not** occur; a
  **phone-initiated Garmin sync** delivered the workout to the Edge 1050 with
  **no USB** and no explicit "send to device". Correct structure on the device.
- **FIT SDK:** `@garmin/fitsdk` produced and round-tripped an equivalent
  structured workout offline (integrity + repeat + targets preserved). Proven as
  a fallback representation, not device ingestion.

**Implication:** the production adapter should target **Garmin Connect** and stop
there — Watt Locker never talks to the physical device. Auth must be treated as
fragile and refreshable; the transport layer must expect 429/Cloudflare failures.

---

## 4. Architectural Principles

1. **Core domain never imports Garmin code.** `WorkoutRecord`, `PlanSegment`,
   templates, TSS/IF, planner, calendar, mobile stay Garmin-agnostic. [REC]
2. **Canonical is authoritative; Garmin is a projection.** Translation is
   one-directional for sync (canonical → Garmin). [REC]
3. **Integration state lives beside the Activity, not inside it** — mirror the
   `sourceArtifact` precedent. [REC/FACT]
4. **Separate translate / transport / coordinate.** A translator is pure and
   offline-testable; a client owns auth+HTTP; a service owns lifecycle. [REC]
5. **Garmin knowledge is confined to the client + translator.** No raw Garmin
   objects, IDs, or error shapes cross the adapter boundary. [REC]
6. **%FTP stays relative until the translation boundary.** The adapter resolves
   relative targets to whatever Garmin needs, using the activity's FTP context;
   the planner contains no Garmin target mapping. [REC/FACT]
7. **Smallest clean abstraction** that gives a durable Garmin boundary and can
   reasonably admit a second platform later — not a speculative framework. [REC]

---

## 5. Proposed Adapter Architecture [REC]

```text
        WATT LOCKER CORE (Garmin-agnostic)
  Planner · Calendar · Templates · Mobile · WorkoutService
                        │  canonical WorkoutRecord / PlanSegment[]
                        ▼
            ┌───────────────────────────────┐
            │      Integration Service       │   coordinates lifecycle,
            │  (activitySyncService)         │   idempotency, persistence,
            │  - generic, provider-neutral   │   auto/manual sync policy
            └───────────────┬───────────────┘
                            │ canonical input + IntegrationResult
                            ▼
            ┌───────────────────────────────┐
            │   Garmin Adapter (facade)      │   implements a generic
            │   implements IWorkoutSyncPort  │   provider port
            └───────┬───────────────┬────────┘
                    │               │
       ┌────────────▼───┐   ┌───────▼───────────────┐
       │ Garmin         │   │ Garmin Connect Client  │
       │ Translator     │   │ (transport + auth)     │
       │ (pure, offline)│   │  - session/token mgmt  │
       │ canonical →    │   │  - HTTP to Connect      │
       │ Garmin payload │   │  - 429/Cloudflare aware │
       └────────────────┘   └───────────┬────────────┘
                                        ▼
                                 Garmin Connect
                                        ▼
                             Garmin phone sync → Device
                             (outside Watt Locker's control)
```

- **Integration Service** (`activitySyncService`, provider-neutral): the only
  thing the API/core calls. Loads the canonical activity + its integration
  record, decides create-vs-update (idempotency), invokes the provider port,
  persists the resulting sync state. Knows *nothing* Garmin-specific.
- **Garmin Adapter**: implements a generic `IWorkoutSyncPort` (below); composes
  the translator + client. The single place that "is Garmin".
- **Garmin Translator** (pure): canonical `WorkoutRecord`/`PlanSegment[]` →
  Garmin workout payload. No network, no auth. Fully unit-testable — this is
  where the POC's proven payload shaping lives.
- **Garmin Connect Client**: owns authentication (persisted token bundle,
  refresh), HTTP calls to Garmin Connect, and maps raw Garmin failures into the
  adapter's error taxonomy. Never surfaces raw Garmin objects upward.

**Language note [OPEN].** The POC is Python (`python-garminconnect` is the only
client that currently defeats Cloudflare TLS fingerprinting). Watt Locker's API
is Node/TypeScript. The client layer is the seam where this is decided:
- Option A: a small **Python sidecar/microservice** exposing the sync operations
  over HTTP/queue, called by the Node client layer. Keeps the proven client.
- Option B: a **Node client** using a TLS-impersonating HTTP layer
  (curl-impersonate/cycletls) to replicate the flow. Higher risk/effort; unproven.
- Option C: FIT-only fallback (no live Connect sync).
This choice affects only the **client layer**, by design — the port, translator,
service, and persistence are unaffected. **Recommend Option A for the first
implementation** (reuses proven code); revisit if a Node client becomes viable.

---

## 6. Component / Module Responsibilities [REC]

| Component | Knows about Garmin? | Responsibility |
|---|---|---|
| Planner / Templates / TSS / Mobile | **No** | Author canonical activities. Never call sync. |
| `WorkoutService` (existing) | **No** | Canonical CRUD; unchanged. |
| `ActivitySyncService` (new, generic) | **No** (provider-neutral) | Orchestrate sync: load activity + integration record, choose create/update, call the port, persist state, apply auto/manual policy. |
| `IWorkoutSyncPort` (new interface) | Abstract | Generic contract every provider adapter implements. |
| `GarminAdapter` (new) | **Yes** | Implement the port for Garmin; compose translator + client. |
| `GarminWorkoutTranslator` (new, pure) | **Yes (structure only)** | Canonical → Garmin payload; resolve %FTP→watts here. Offline-testable. |
| `GarminConnectClient` (new) | **Yes (transport/auth)** | Auth/token lifecycle, HTTP to Connect, map raw errors → taxonomy. |
| `ActivityIntegrationRepository` (new) | **No** (generic) | Persist external identity + sync state per (activity, provider). |
| Garmin credential store | **Yes (secrets)** | Encrypted per-user token bundle (extends `ConnectedSource`). |

---

## 7. Dependency Direction [REC]

```text
Core Domain (WorkoutRecord, PlanSegment, templates)   ← imports nothing below
        ▲
ActivitySyncService (generic)                         ← imports Core + Port
        ▲
IWorkoutSyncPort (interface)                          ← Core-level types only
        ▲
GarminAdapter                                          ← imports Port + Translator + Client
        ▲
GarminTranslator / GarminConnectClient                ← the only Garmin-aware code
```

**Hard rule:** nothing in Core or `ActivitySyncService` may `import` a
Garmin-specific module. Enforced by the port interface using only canonical
types + generic integration results. (Optionally lint-guard later.)

---

## 8. Canonical Activity → Garmin Translation Boundary [REC]

The translator is the *only* place canonical concepts become Garmin concepts.

| Canonical | Garmin workout concept | Mapping | Notes |
|---|---|---|---|
| Activity (`WorkoutRecord`) | Workout | 1:1 | name=`title`, sport from `activityType`. |
| `activityType` | Garmin sport/subSport | table | cycling proven [POC]; run/others [OPEN]. |
| `segments[]` (flat) | ordered workout steps + repeat groups | expand `repeatId` runs into Garmin repeat groups | POC preserved repeats. |
| step `name` | step name | 1:1 | optional. |
| `durationType='time'` + `durationSeconds` | time end-condition | 1:1 | seconds. |
| `durationType='distance'` + `distanceMeters` | distance end-condition | 1:1 | meters. |
| `intensityMetric='power_ftp'` + `powerMin/Max` (%) | power target (watts range) | **resolve %→watts using activity FTP at translation time** | %FTP stays canonical until here. |
| `intensityMetric='power_watts'` | power target (watts) | 1:1 | literal watts. |
| `intensityMetric='hr_threshold'/'hr_max'` + `hrMin/Max` | HR target | resolve against HR threshold if available | see §9/limitations. |
| `cadenceMin/Max` | cadence target | 1:1 where supported | [OPEN] per sport. |
| `repeatCount` | repeat group iterations | 1:1 | first-child authoritative. |
| `notes` | step/workout notes | 1:1 if Garmin field exists | else omit + warn. |

**FTP resolution** happens in the translator using the same
`resolvePlanningFtp`/FTP-history semantics the UI uses (ported/shared), so a
Garmin workout carries absolute watts while the canonical activity keeps %FTP.
The planner never does this.

### Unsupported / lossy canonical features [REC — to finalize during PLAN-063+]

| Canonical feature | Garmin capability | Exact map? | Handling |
|---|---|---|---|
| Repeat block (single level) | Repeat group | Yes [POC] | Map directly. |
| Nested blocks | (Watt Locker forbids nesting) | N/A | Not applicable. |
| `hr_threshold`/`hr_max` targets | HR zones/targets | Partial | Watt Locker has FTP history but **no HR-threshold history** [FACT] — resolution basis is weak. Recommend: translate as %-based HR if Garmin supports it, else omit target + **sync warning**. |
| Cadence-only step | Cadence target | Likely | Confirm per sport; else warning. |
| `steady` / mixed target types | Garmin step types | Mostly | Map to closest Garmin intensity; document. |
| Distance step TSS | (N/A) | — | Distance steps contribute 0 to TSS canonically [FACT]; irrelevant to Garmin payload. |
| Activity-level notes/description | Workout description | If field exists | Else omit. |

**Rule:** never silently invent semantics. If a feature can't be represented,
the translator returns a **structured warning** the service surfaces to the user;
if the whole structure is invalid it returns a **permanent validation error**
(no network call).

---

## 9. Authentication Architecture [REC]

- **Per-user, not application-level.** Each user connects their own Garmin
  account (like Strava). Mirrors `ConnectedSource` (`provider:'garmin'`,
  `connected`, `connectedAt`, `oauthTokenEncrypted`). [FACT precedent]
- **Auth lives entirely in the Garmin Connect Client.** Core/service never see
  cookies, tokens, DI bearer, or session objects. The service asks the port for
  `getConnectionStatus()` and receives a canonical status enum only.
- **Token bundle** (DI token / refresh token / client id per POC) is stored
  **encrypted at rest**, keyed by `userId`+provider. **Do not** use the POC's
  plaintext token *file* in production. [REC] Extend `ConnectedSource`
  (`oauthTokenEncrypted`) or a dedicated encrypted credential record.
- **Refresh/re-auth:** the client refreshes the DI token proactively (POC does
  this). On refresh failure → `AuthExpired`/`AuthRejected` result; the service
  marks the connection as needing reconnect and surfaces a reconnect prompt.
- **Initial connect flow [OPEN]:** Garmin's unofficial flow needs
  email/password + MFA. Options: (a) a one-time server-side connect endpoint that
  accepts credentials, performs login in the client layer, persists only the
  resulting encrypted token bundle, and **never stores the password**; (b) a
  guided local/desktop connect that uploads only the token bundle. Given the
  MFA + Cloudflare constraints, **(a)** with immediate credential discard is the
  likely MVP. Requires explicit security review (§ risks).

---

## 10. External Identity / Persistence Recommendation [REC]

**Do not** add `garminId`/`garminSyncStatus`/`garminLastSync` to `WorkoutRecord`.
Instead introduce a **generic per-(activity,provider) integration record**,
mirroring `sourceArtifact` (which already stores external identity beside the
activity via `activityId`).

*Proposed collection `activityIntegrations` (NOT implemented here):*

```text
ActivityIntegration {
  id
  userId
  activityId          // canonical WorkoutRecord.id (association, not identity)
  provider            // 'garmin' | future providers  (reuse DataSource-style enum)

  // External identity (opaque to core)
  externalWorkoutId?      // Garmin workout id
  externalScheduleId?     // Garmin scheduled-workout id (if distinct)

  // Sync state
  syncState           // 'not_synced' | 'synced' | 'pending' | 'changes_pending'
                      //  | 'sync_failed' | 'remote_deleted'
  lastSyncedAt?
  lastAttemptedAt?
  lastError?          // canonical error code + safe message (no raw Garmin)
  contentHash?        // hash of the translated payload for change detection
  createdAt, updatedAt
}
```

- **Identity stays canonical:** the activity's identity is unchanged; the Garmin
  id is opaque data on a side record.
- **Generic:** `provider` makes it reusable for future platforms — one small
  collection, not a per-provider field explosion.
- **`contentHash`** enables cheap "changes not synced" detection (see §14).
- **Indexes (proposed):** `{userId, activityId, provider}` unique;
  `{userId, provider, syncState}` for dashboards/auto-sync scans.
- **Lifecycle coupling:** when a canonical activity is deleted, the service
  decides Garmin handling (§11) and removes/updates the integration record. The
  canonical delete path itself stays Garmin-agnostic (the service reacts, the
  model doesn't reference Garmin).

---

## 11. Create / Update / Schedule / Delete Lifecycle [REC]

```text
planned activity created ──▶ (auto or manual) sync
        │
        ▼
   createWorkout (Garmin) ──▶ store externalWorkoutId, syncState=synced
        │
        ▼
   scheduleWorkout(date) ──▶ store externalScheduleId
        │
        ▼   (user edits the planned activity)
   updateWorkout ──▶ update in place (same externalWorkoutId); reschedule if date changed
        │
        ▼
   completed / skipped / deleted ──▶ provider-appropriate handling
```

**Operation classification (to confirm against Garmin during PLAN-063+):**

| Operation | MVP? | Notes / risk |
|---|---|---|
| `createWorkout` | **Required** | Proven [POC]. |
| `scheduleWorkout(date)` | **Required** | Proven [POC]; distinct from create. |
| `updateWorkout` | **Required** | Must update in place (idempotency, §14) to avoid duplicates. Confirm Garmin PUT semantics. |
| `deleteWorkout` | **Useful** | For cancelled/deleted plans. Confirm Garmin delete. |
| `unschedule` (remove from calendar without deleting) | **Useful/Optional** | If Garmin distinguishes. |
| Read-back / verify remote exists | **Useful** | To detect `remote_deleted`. |
| Direct device push | **Unsupported** | Watt Locker stops at Connect; phone sync delivers to device [POC]. |
| Completed-activity *import* from Garmin | **Out of scope** | Inbound is the existing `sourceArtifact`/Strava path, not this outbound design. |

**Asymmetry warning [POC]:** do not assume create/update/schedule/delete are
symmetric or all supported identically by the unofficial API. Each must be
validated during implementation; the design already routes each through its own
port method so partial support degrades gracefully.

---

## 12. Auto-Sync / Manual-Sync Architecture [REC]

- A future Admin setting **`autoSyncToGarmin: boolean`** lives in
  `UserSettings`-style config (not implemented now), read by the
  `ActivitySyncService`.
- **Auto ON:** saving/editing an *eligible* planned activity enqueues a sync
  (create or update). Eligibility rules [OPEN]: e.g. `status==='planned'`,
  has structured `segments` or planned targets, `activityType` mappable, user
  Garmin-connected. Editing an already-synced activity → update/resync.
- **Auto OFF:** the user invokes a manual "Sync to Garmin" action per activity.
- Both modes call the **same** `ActivitySyncService.sync(activityId, userId)` —
  auto-sync is just an automatic trigger of the manual operation, so there is one
  code path and one idempotency guarantee.
- **Trigger mechanism [OPEN]:** synchronous on save vs. background job/queue.
  Given Garmin latency + 429 risk, **recommend asynchronous** (job/queue with
  retry/backoff) so the planner save is never blocked on Garmin. MVP could be a
  simple in-process queue; document as a decision.

---

## 13. Error-Handling Strategy [REC]

The client maps raw Garmin failures into a **canonical taxonomy**; nothing above
the client sees Garmin error shapes. Suggested categories:

| Category | Examples | Retryable? | User surface |
|---|---|---|---|
| **Auth** | token expired, login rejected, MFA required | No (needs reconnect) | "Reconnect Garmin". |
| **Transient** | 429/Cloudflare, 5xx, network timeout, Garmin unavailable | Yes (backoff) | "Sync will retry". |
| **Validation/Translation (permanent)** | unsupported structure, invalid payload | No | Specific message; do not retry. |
| **Not-found / remote-deleted** | scheduled/ workout gone on Garmin | Special | Re-create on next sync (§14). |
| **Unknown external** | unexpected Garmin response | No (log) | Generic "sync failed"; logged for diagnosis. |

- Map onto existing `utils/errors.ts` conventions where it crosses the API
  (`AuthenticationError`, `ValidationError`, a new transient/`ConflictError`).
- **Never leak raw Garmin text, cookies, tokens, or endpoints** into responses or
  logs surfaced to users. `lastError` on the integration record stores a
  canonical code + safe message.

---

## 14. Idempotency / Resynchronization Strategy [REC]

- The `activityIntegrations` record is the Watt Locker↔Garmin link. Sync logic:
  1. Load integration record for (activity, `garmin`).
  2. **No record / `not_synced`** → `createWorkout`, store `externalWorkoutId`.
  3. **Has `externalWorkoutId`** → `updateWorkout` in place (never create a
     duplicate). Reschedule only if the date changed.
  4. Compare `contentHash(translatedPayload)`; if unchanged, **skip** the network
     call (cheap no-op) — makes repeated manual syncs / auto-sync idempotent.
- **Remote deleted independently:** if `updateWorkout` returns not-found, mark
  `remote_deleted`, then **re-create** and update the stored id (self-healing).
- **Never** key idempotency on display order or step numbering (recomputed, not
  identity — consistent with PLAN-061). Key on `externalWorkoutId` + `contentHash`.

---

## 15. Garmin API Risk Assessment [POC/REC]

- **Current approach:** unofficial/reverse-engineered Garmin Connect private API
  via `python-garminconnect` + `curl_cffi` TLS impersonation.
- **Benefits:** fully validated end-to-end (create/schedule/device), no Garmin
  Developer Program approval needed, supports genuine repeat groups + targets.
- **Risks / likely failure modes:** Garmin can change auth (they did in March
  2026 — Cloudflare TLS fingerprinting), rate-limit (429s observed), or alter
  payloads at any time; ToS/stability risk; token expiry/refresh breakage.
- **Isolation strategy:** confine *all* of this to the **client layer** behind
  `IWorkoutSyncPort`. A Garmin change is a client/translator fix — no core,
  service, persistence, API, or UI change. The `contentHash`/state model tolerates
  partial outages (transient errors retry; auth errors prompt reconnect).
- **Replacement strategy:** because the port is generic, the Garmin client can be
  swapped (Python sidecar → Node client, or → official API if Garmin ever offers
  one) without touching anything above it.

---

## 16. FIT SDK Fallback Considerations [POC/REC]

- **Role:** secondary / manual-transfer path, **not** the primary integration.
  `@garmin/fitsdk` (Node) produces a structurally valid, decodable FIT workout
  from the same canonical structure (proven offline in the POC).
- **Where it fits:** a second implementation of the **translator** concept
  (canonical → FIT), optionally behind the same `IWorkoutSyncPort` as an
  "export/download" capability rather than a live Connect sync. Lets users
  manually import a FIT file if the unofficial Connect path is down.
- **Limitation:** FIT round-trip proves representation, **not** device ingestion;
  do not claim Edge compatibility from SDK round-tripping alone (per POC caveat).
- **Recommendation:** keep FIT as a documented fallback capability; implement only
  if/when the live path proves unreliable in production. Do not build it now.

---

## 17. Future Integration Extensibility [REC]

- The `IWorkoutSyncPort` + generic `ActivityIntegration` record + generic
  `ActivitySyncService` mean a second platform (e.g. TrainingPeaks — already a
  `DataSource` value) is a **new adapter + a new `provider` value**, with no
  planner/core change.
- Keep it minimal: one port interface, one integration collection with a
  `provider` discriminator, one generic service. **Do not** build a speculative
  "integration framework," plugin registry, or generalized field-mapping DSL now.

```text
Canonical Activity
   ├── GarminAdapter          (PLAN-063+)
   ├── TrainingPeaksAdapter   (future)
   └── <future platform>      (future)
        all via one IWorkoutSyncPort + one ActivityIntegration model
```

---

## 18. Configuration & Secrets [REC]

- **Per-user credentials** (Garmin account is the user's), stored **encrypted at
  rest**, mirroring `ConnectedSource.oauthTokenEncrypted`. Not application-level.
- **App-level config** (e.g. sidecar URL, any Garmin client tuning) → a
  `config.garmin` block in `config/env.ts` fed by env vars (mirrors
  `config.strava`). No secrets in source or the POC token-file format for
  production.
- **Encryption:** reuse whatever key-management the app adopts for
  `oauthTokenEncrypted` (define during implementation; needs a real KMS/secret,
  not a hardcoded key). [OPEN — security review]
- The **token file** approach from the POC is fine for research but **not** for
  production; production persists the encrypted bundle in the DB per user.

---

## 19. API & UI Boundaries [REC]

**API (later task, not now):** expose a **generic** operation, not Garmin-specific:
```text
POST /api/activities/:id/sync         # provider defaults to configured/garmin
GET  /api/activities/:id/sync         # returns canonical sync state
POST /api/integrations/garmin/connect # one-time connect (auth in client layer)
GET  /api/integrations/garmin/status  # canonical connection status
```
The planner/templates never call Garmin; they call these generic endpoints,
which call `ActivitySyncService`. Garmin-specific routes are justified only for
the *connect/auth* flow (provider-specific by nature); sync is generic.

**UI (later task, not now):** sync concerns live **outside** the canonical planner
components — a small integration surface: connection status + reconnect, Admin
`Auto-Sync to Garmin` toggle, a per-activity "Sync to Garmin" action + sync-state
badge (synced / changes pending / failed / last synced). None of this belongs in
`PlanActivityPage`, `StepEditor`, `RepeatBlockEditor`, or `TemplateTray`.

---

## Proposed Implementation Sequence (PLAN-063 onward) [REC]

Smallest safe increments; each independently testable:

1. **PLAN-063 — Ports & persistence skeleton.** Define `IWorkoutSyncPort`
   (canonical types only) + `ActivityIntegration` model/repository/indexes.
   No Garmin code, no network. Unit tests for the repo + ownership.
2. **PLAN-064 — Garmin translator (pure).** Canonical → Garmin payload incl.
   %FTP→watts resolution, repeat groups, duration/target mapping, and the
   unsupported-feature warning/error contract. Fully offline unit tests
   (reuse POC payloads as fixtures). No network.
3. **PLAN-065 — Garmin Connect client + auth.** Transport + token lifecycle +
   error taxonomy mapping. Decide sidecar (Python) vs Node client (§5 [OPEN]).
   Contract-tested against recorded fixtures; live smoke test manual.
4. **PLAN-066 — Garmin adapter + create/update.** Compose translator + client
   behind the port; idempotent create-or-update via `externalWorkoutId` +
   `contentHash`.
5. **PLAN-067 — Scheduling + delete/lifecycle.** `scheduleWorkout`, reschedule,
   delete/remote-deleted self-heal.
6. **PLAN-068 — Sync orchestration service.** Generic `ActivitySyncService`
   (`sync(activityId,userId)`), async job/queue + retry/backoff, sync-state
   transitions.
7. **PLAN-069 — Admin Auto-Sync setting + generic sync API.**
   `autoSyncToGarmin`, `POST /activities/:id/sync`, connect/status endpoints.
8. **PLAN-070 — UI sync surface.** Connection status, manual sync, sync-state
   badges, reconnect flow — outside the planner components.
9. **PLAN-071 — Integration testing + hardening.** End-to-end against a real
   account; 429/backoff, auth-expiry reconnect, remote-deleted recovery.
10. **(Deferred) FIT fallback export**, only if the live path proves unreliable.

---

## Open Questions / Decisions Requiring Approval

1. **[OPEN] Client language/topology (§5):** Python sidecar (reuse proven
   `python-garminconnect`) vs a Node TLS-impersonating client. Recommend sidecar
   for the first cut. Affects only the client layer.
2. **[OPEN] Connect/auth flow (§9):** server-side email/password+MFA connect
   (discard password, persist encrypted tokens) vs. an alternative. Needs
   security review — this is the highest-risk area (handling Garmin credentials +
   MFA). No credentials should ever be logged or stored in plaintext.
3. **[OPEN] Sync trigger (§12):** synchronous-on-save vs asynchronous job/queue.
   Recommend async given Garmin latency/429s.
4. **[OPEN] Eligibility rules (§12):** which planned activities auto-sync
   (status, structure, mappable sport, connected user).
5. **[OPEN] HR-target mapping (§8):** no HR-threshold history exists today; decide
   omit-with-warning vs. add HR-threshold history (a *separate* canonical
   enhancement, not part of Garmin work).
6. **[OPEN] Secret/key management (§18):** concrete encryption/KMS for the token
   bundle; must not be a hardcoded key.
7. **[OPEN] Sport coverage for MVP (§8):** cycling proven; confirm run/others
   mapping before enabling.
8. **[OPEN] Delete semantics (§11):** confirm Garmin delete/unschedule behavior
   before relying on it; degrade gracefully if unsupported.

---

## Verification / Scope Confirmation

- Inspected actual current code (canonical model, `PlanSegment`, repeat model,
  `sourceArtifact` provenance, `ConnectedSource`, `config/env.ts`, DI/adapter
  patterns, errors) and the PLAN-053/054 Garmin POC evidence. Proposed boundaries
  were checked against the existing `sourceArtifact` / Strava / `FileStorageAdapter`
  patterns and follow them.
- **No production source code, schema, migration, route, UI, dependency, or
  config was modified.** The only artifact is this design document.
