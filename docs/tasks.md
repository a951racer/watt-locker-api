# Implementation Plan: Cycle Analyzer

## Overview

This plan implements the Watt Locker cycling workout tracking backend (WattLocker_API) as a Node.js/TypeScript REST API with MongoDB Atlas for data storage and Google Drive for raw file persistence. The implementation follows a layered architecture: transport → service → parser → storage, using the repository pattern for database access and the strategy pattern for file parsers.

## Tasks

- [x] 1. Project setup and core infrastructure
  - [x] 1.1 Initialize Node.js/TypeScript project with Express
    - Create project directory structure: `src/`, `src/routes/`, `src/services/`, `src/parsers/`, `src/repositories/`, `src/middleware/`, `src/models/`, `src/config/`, `src/utils/`
    - Initialize `package.json` with TypeScript, Express, MongoDB driver, and dev dependencies (jest, ts-jest, fast-check, supertest, mongodb-memory-server, nock)
    - Configure `tsconfig.json` with strict mode
    - Create `.env.example` with required environment variables (MONGO_URI, JWT_SECRET, GOOGLE_CLIENT_ID, STRAVA_CLIENT_ID, etc.)
    - Set up ESLint and Prettier configuration
    - _Requirements: 14.1_

  - [x] 1.2 Define core TypeScript interfaces and types
    - Create `src/models/workout.ts` with `WorkoutRecord`, `MetricDataPoint`, `ParsedWorkout`, `LapSummary`, `WorkoutFileFormat`, `DataSource` types
    - Create `src/models/user.ts` with `UserProfile`, `UserContext`, `AuthResult` types
    - Create `src/models/settings.ts` with `UserSettings`, `ConnectedSource` types
    - Create `src/models/api.ts` with `ApiResponse`, `ApiError`, `ErrorResponse`, `PaginatedResult` envelope types
    - Create `src/models/upload.ts` with `UploadResult`, `BulkUploadResult`, `FailedUpload` types
    - _Requirements: 11.2, 6.1, 6.2_

  - [x] 1.3 Set up API response envelope and error handling utilities
    - Create `src/utils/response.ts` with helper functions to wrap responses in consistent envelope (`{ data, errors, pagination }`)
    - Create `src/utils/errors.ts` with custom error classes (ValidationError, AuthenticationError, ConflictError, NotFoundError)
    - Create `src/middleware/errorHandler.ts` global error handler that catches errors and returns formatted responses with correlation IDs
    - Create `src/middleware/correlationId.ts` middleware to generate UUID v4 correlation IDs per request
    - _Requirements: 11.2, 11.5_

  - [ ]* 1.4 Write property test for API response envelope consistency
    - **Property 12: API Response Envelope Consistency**
    - **Validates: Requirements 11.2**

- [x] 2. Authentication system
  - [x] 2.1 Implement User repository and password hashing
    - Create `src/repositories/userRepository.ts` with interface and MongoDB implementation
    - Implement `create`, `findByEmail`, `findById` methods
    - Use bcrypt for password hashing with configurable salt rounds
    - Create MongoDB index on `email` (unique)
    - _Requirements: 12.1, 12.6_

  - [x] 2.2 Implement Auth service (register, login, refresh)
    - Create `src/services/authService.ts` implementing the `AuthService` interface
    - Implement `register` — validate email/password, hash password, create user, return tokens
    - Implement `login` — verify credentials, generate short-lived access token (15 min) and refresh token (7 days)
    - Implement `refreshToken` — validate refresh token, issue new token pair
    - Implement `validateToken` — decode and verify JWT, return UserContext
    - Use `jsonwebtoken` library for JWT operations
    - _Requirements: 12.2, 12.3_

  - [x] 2.3 Implement JWT authentication middleware
    - Create `src/middleware/auth.ts` that extracts Bearer token from Authorization header
    - Validate token and attach `UserContext` to request object
    - Return 401 for missing, expired, or malformed tokens
    - _Requirements: 12.4, 12.5_

  - [ ]* 2.4 Write property test for JWT authentication enforcement
    - **Property 13: JWT Authentication Enforcement**
    - **Validates: Requirements 12.4, 12.5**

  - [x] 2.5 Create auth routes
    - Create `src/routes/auth.ts` with POST `/api/auth/register`, POST `/api/auth/login`, POST `/api/auth/refresh`
    - Add request validation (email format, password minimum length)
    - _Requirements: 12.1, 12.2, 12.3_

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. User settings
  - [x] 4.1 Implement Settings repository
    - Create `src/repositories/settingsRepository.ts` with interface and MongoDB implementation
    - Implement `findByUserId`, `upsert` methods
    - Apply defaults for `driveStoragePath` ("WattLocker") and `driveInboxPath` ("WattLocker/Inbox") when creating
    - Create MongoDB index on `userId` (unique)
    - _Requirements: 13.2, 13.3_

  - [x] 4.2 Implement Settings service
    - Create `src/services/settingsService.ts` implementing the `SettingsService` interface
    - Implement `getSettings` — return existing settings or create with defaults
    - Implement `updateSettings` — partial update, persist immediately
    - _Requirements: 13.5, 13.6_

  - [x] 4.3 Create settings routes
    - Create `src/routes/settings.ts` with GET `/api/settings` and PUT `/api/settings`
    - Both endpoints require JWT authentication
    - Validate update payload (valid folder paths, valid provider names)
    - _Requirements: 13.6_

  - [ ]* 4.4 Write property test for settings persistence
    - **Property 14: Settings Persistence**
    - **Validates: Requirements 13.2, 13.3, 13.5**

- [x] 5. Workout file parsers
  - [x] 5.1 Implement Parser Factory and parser interface
    - Create `src/parsers/parserFactory.ts` implementing `ParserFactory` interface
    - Register parsers by file extension and MIME type
    - Throw ValidationError for unsupported formats with list of supported formats
    - _Requirements: 3.5_

  - [x] 5.2 Implement FIT file parser
    - Create `src/parsers/fitParser.ts` implementing `WorkoutParser` interface
    - Use a FIT SDK library (e.g., `fit-file-parser`) to decode binary FIT files
    - Extract activity records: timestamps, heart rate, power, cadence, speed, distance, GPS, elevation
    - Extract lap summaries
    - _Requirements: 3.1, 4.1_

  - [x] 5.3 Implement TCX file parser
    - Create `src/parsers/tcxParser.ts` implementing `WorkoutParser` interface
    - Parse XML using a library (e.g., `fast-xml-parser`)
    - Extract all trackpoint elements with associated metrics
    - Extract lap data from `<Lap>` elements
    - _Requirements: 3.2, 4.2_

  - [x] 5.4 Implement GPX file parser
    - Create `src/parsers/gpxParser.ts` implementing `WorkoutParser` interface
    - Parse XML, extract track segments (`<trkseg>`) and waypoints
    - Handle GPX extensions for heart rate, power, cadence
    - _Requirements: 3.3, 4.3_

  - [x] 5.5 Implement Pretty Printer for each format
    - Create `src/parsers/prettyPrinter.ts` implementing `WorkoutPrettyPrinter` interface
    - Implement FIT, TCX, and GPX output formatters
    - Ensure output produces valid files that can be re-parsed
    - _Requirements: 4.4_

  - [ ]* 5.6 Write property test for parser round-trip
    - **Property 1: Parser Round-Trip**
    - **Validates: Requirements 4.4, 4.5**

  - [ ]* 5.7 Write property test for metric extraction completeness
    - **Property 2: Metric Extraction Completeness**
    - **Validates: Requirements 3.4, 4.1, 4.2, 4.3**

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Google Drive integration
  - [x] 7.1 Implement Google Drive storage adapter
    - Create `src/storage/googleDriveAdapter.ts` implementing `FileStorageAdapter` interface
    - Implement OAuth 2.0 token management (store encrypted tokens in user settings)
    - Implement `store` — upload file to correct year/month folder, create folders if needed
    - Implement `retrieve` — download file by Drive file ID
    - Implement `delete` — remove file from Drive
    - Implement `listFiles` — list files in a given folder path
    - Implement `removeFromFolder` — delete file from inbox after processing
    - Use Google Drive API v3 via `googleapis` library
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 7.2 Implement Drive folder path derivation
    - Create `src/utils/drivePath.ts` with function to generate `{basePath}/YYYY/MM` from workout date
    - Use user's configured `driveStoragePath` as base
    - _Requirements: 5.3_

  - [ ]* 7.3 Write property test for Drive folder path derivation
    - **Property 5: Drive Folder Path Derivation**
    - **Validates: Requirements 5.3**

  - [x] 7.4 Create Google Drive OAuth routes
    - Create `src/routes/googleAuth.ts` with endpoints to initiate and complete Google OAuth flow
    - Store refresh token encrypted in user settings
    - _Requirements: 5.1_

- [x] 8. MongoDB repositories (workout and metrics)
  - [x] 8.1 Implement Workout Repository interface and MongoDB implementation
    - Create `src/repositories/workoutRepository.ts` with the `WorkoutRepository` interface
    - Implement MongoDB-backed `create`, `findById`, `findMany`, `update`, `delete`, `findDuplicate`
    - Implement `insertMetrics` and `queryMetrics` for time-series collection
    - Create indexes: `{ userId: 1, startTime: -1 }`, `{ userId: 1, sourceActivityId: 1 }` (unique sparse)
    - _Requirements: 6.1, 6.2, 6.5, 6.6_

  - [x] 8.2 Set up MongoDB time-series collection for metrics
    - Create collection initialization script/utility that creates the `metrics` time-series collection with `timeField: "timestamp"`, `metaField: "meta"`, `granularity: "seconds"`
    - Ensure collection is created on application startup if not exists
    - _Requirements: 6.1, 6.4_

  - [x] 8.3 Implement duplicate detection logic
    - Add `findDuplicate` method that checks for matching `startTime` and `durationSeconds` for the same user
    - Return existing record if duplicate found
    - _Requirements: 6.3_

  - [ ]* 8.4 Write property test for duplicate detection
    - **Property 7: Duplicate Detection**
    - **Validates: Requirements 6.3**

  - [ ]* 8.5 Write property test for metric data point structure
    - **Property 6: Metric Data Point Structure**
    - **Validates: Requirements 6.1, 6.2**

- [x] 9. Upload service (single + bulk + inbox)
  - [x] 9.1 Implement single file upload service
    - Create `src/services/uploadService.ts` implementing `UploadService` interface
    - Implement `uploadSingle` pipeline: validate format → parse file → check duplicate → store in Drive → save workout record + metrics to DB
    - Handle transactional guarantee: if Drive upload succeeds but DB write fails, log orphaned file
    - Return `UploadResult` with workoutId and driveFileId
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 9.2 Implement bulk upload service
    - Implement `uploadBulk` — process each file independently through `uploadSingle`
    - Track success/failure for each file independently
    - Continue processing remaining files when one fails
    - Return `BulkUploadResult` with complete summary
    - _Requirements: 2.1, 2.2, 2.6, 2.7, 2.8_

  - [x] 9.3 Implement inbox ingestion service
    - Implement `ingestFromInbox` — list files in user's inbox folder, process each through upload pipeline
    - Remove successfully processed files from inbox
    - Leave failed files in inbox for retry
    - _Requirements: 2.3, 2.4, 2.5_

  - [ ]* 9.4 Write property test for bulk upload independence
    - **Property 3: Bulk Upload Independence**
    - **Validates: Requirements 2.1, 2.6, 2.7**

  - [ ]* 9.5 Write property test for inbox ingestion cleanup
    - **Property 4: Inbox Ingestion Cleanup**
    - **Validates: Requirements 2.5**

- [x] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Strava integration
  - [x] 11.1 Implement Strava OAuth flow
    - Create `src/services/stravaSyncService.ts` implementing `StravaSyncService` interface
    - Create `src/routes/strava.ts` with OAuth initiation and callback endpoints
    - Store Strava access/refresh tokens encrypted in user settings
    - _Requirements: 8.1_

  - [x] 11.2 Implement Strava webhook handler
    - Implement `verifyWebhook` for GET verification challenge
    - Implement `handleWebhookEvent` — validate signature, check for duplicates, enqueue download job
    - Create webhook routes: GET `/api/webhooks/strava` (verification), POST `/api/webhooks/strava` (events)
    - _Requirements: 8.2, 8.7_

  - [x] 11.3 Implement Strava activity download and ingestion
    - Download original workout file (prefer FIT/TCX) via Strava export endpoint
    - Pass downloaded file through standard `uploadSingle` pipeline with `dataSource: 'strava'`
    - _Requirements: 8.3, 8.5_

  - [x] 11.4 Implement historical sync with rate limiting
    - Implement `syncHistorical` — fetch activity list from Strava, filter out already-ingested activities, download and ingest remaining
    - Implement rate limiter: respect 200 requests/15 min and 2000/day limits
    - Use internal job queue with throttling for bulk downloads
    - _Requirements: 8.4, 8.6_

  - [ ]* 11.5 Write property test for Strava sync set difference
    - **Property 10: Strava Sync Set Difference**
    - **Validates: Requirements 8.4**

- [ ] 12. Workout CRUD operations
  - [x] 12.1 Implement Workout CRUD service
    - Create `src/services/workoutService.ts` implementing workout CRUD logic
    - Implement `getWorkout` — fetch by ID, include summary metrics and Drive reference
    - Implement `listWorkouts` — paginated, sorted by date descending, with filtering
    - Implement `updateWorkout` — update metadata fields (title, description, tags, activityType)
    - Implement `deleteWorkout` — remove from DB, optionally remove from Drive based on user preference
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 12.2 Create workout CRUD routes
    - Create `src/routes/workouts.ts` with all workout endpoints
    - GET `/api/workouts` — list with query params for pagination and filters
    - GET `/api/workouts/:id` — single workout detail
    - PUT `/api/workouts/:id` — update metadata
    - DELETE `/api/workouts/:id` — delete with optional `removeFromDrive` query param
    - POST `/api/workouts/upload` — single file upload
    - POST `/api/workouts/upload/bulk` — bulk file upload
    - POST `/api/workouts/ingest/inbox` — trigger inbox ingestion
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 11.1_

  - [ ]* 12.3 Write property test for workout list sorting and pagination
    - **Property 8: Workout List Sorting and Pagination**
    - **Validates: Requirements 7.2**

  - [ ]* 12.4 Write property test for workout filter correctness
    - **Property 9: Workout Filter Correctness**
    - **Validates: Requirements 7.5**

- [ ] 13. REST API layer (validation, rate limiting, CORS, health)
  - [x] 13.1 Implement request validation middleware
    - Create `src/middleware/validation.ts` using a validation library (e.g., `zod` or `joi`)
    - Define schemas for all request payloads (auth, settings, workout update, upload)
    - Return 400 with descriptive error messages for invalid payloads
    - _Requirements: 11.3_

  - [ ]* 13.2 Write property test for input validation
    - **Property 11: Input Validation Rejects Invalid Payloads**
    - **Validates: Requirements 11.3**

  - [x] 13.3 Implement rate limiting
    - Create `src/middleware/rateLimiter.ts` using `express-rate-limit` or similar
    - Configure per-endpoint rate limits (e.g., stricter on auth endpoints)
    - Return 429 with retry-after header when limit exceeded
    - _Requirements: 11.4_

  - [x] 13.4 Configure CORS and health check
    - Create `src/middleware/cors.ts` with configurable allowed origins (WattLocker_Web domain)
    - Create `src/routes/health.ts` with GET `/api/health` endpoint (no auth required)
    - _Requirements: 14.3_

  - [x] 13.5 Wire up Express application
    - Create `src/app.ts` that assembles all middleware and routes
    - Create `src/server.ts` entry point that connects to MongoDB and starts the server
    - Register middleware in correct order: correlationId → CORS → rateLimiter → bodyParser → auth → routes → errorHandler
    - _Requirements: 11.1, 14.1_

- [x] 14. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 15. Integration tests
  - [ ]* 15.1 Write integration tests for upload pipeline
    - Test single file upload end-to-end with mocked Google Drive and mongodb-memory-server
    - Test bulk upload with mixed success/failure files
    - Test inbox ingestion flow
    - _Requirements: 1.1, 1.2, 2.1, 2.5_

  - [ ]* 15.2 Write integration tests for Strava webhook flow
    - Test webhook verification handshake
    - Test activity create event → download → ingest flow with mocked Strava API (nock)
    - Test duplicate activity skip
    - _Requirements: 8.2, 8.3, 8.7_

  - [ ]* 15.3 Write integration tests for CRUD operations
    - Test full workout lifecycle: upload → list → get → update → delete
    - Test pagination and filtering via REST API (supertest)
    - Test auth enforcement on all protected endpoints
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 12.4, 12.5_

- [x] 16. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document using fast-check
- Unit tests validate specific examples and edge cases
- The frontend (WattLocker_Web) is in a separate repository and is NOT part of this implementation plan — only the REST API backend is implemented here
- TrainingPeaks and Garmin Connect integrations (Requirement 9) are deferred as the architecture is extensible; Strava is the priority integration
- Google Drive and Strava API interactions should be tested via dependency injection with mocked adapters
