# Requirements Document

## Introduction

**Watt Locker** is a cycling workout tracking application that gives cyclists full ownership of their training data. The application ingests workout data from popular platforms (Strava, TrainingPeaks), stores raw workout files in the user's Google Drive for personal data sovereignty, and loads structured workout data into a time-series database for analysis. A REST API backend handles data ingestion, storage orchestration, and CRUD operations, while a separate web frontend provides dashboards, reporting, and analysis tools.

## Glossary

- **WattLocker_API**: The backend REST API service responsible for handling file uploads, CRUD operations, Google Drive storage, and database ingestion
- **WattLocker_Web**: The frontend web application providing dashboards, reporting, and analysis tools
- **Workout_File**: A file containing cycling workout data in a supported format (FIT, TCX, GPX) exported from a training platform
- **Workout_Record**: A structured database entry representing a single cycling workout with time-series metrics
- **Google_Drive_Store**: The user's personal Google Drive folder where raw workout files are persisted
- **Time_Series_DB**: MongoDB Atlas with time-series collections, accessed through a repository abstraction layer to enable future migration to alternative time-series databases (e.g., TimescaleDB, InfluxDB)
- **Bulk_Upload**: An operation that processes multiple workout files, either uploaded directly via the web UI or ingested from a designated Google Drive inbox folder
- **Inbox_Folder**: A user-configurable folder path in the user's Google Drive where files can be dropped for bulk ingestion (set via Settings page)
- **Data_Source**: An external platform from which workout data originates (Strava, TrainingPeaks, Garmin Connect)
- **Metric**: A time-series data point within a workout (e.g., heart rate, power, cadence, speed, GPS coordinates)
- **Dashboard**: The primary view in WattLocker_Web displaying workout summaries, trends, and key performance indicators

## Requirements

### Requirement 1: Single Workout File Upload

**User Story:** As a cyclist, I want to upload a single workout file, so that my workout data is stored safely and available for analysis.

#### Acceptance Criteria

1. WHEN a single Workout_File is submitted via the upload endpoint, THE WattLocker_API SHALL store the file in the Google_Drive_Store
2. WHEN a single Workout_File is successfully stored in Google_Drive_Store, THE WattLocker_API SHALL parse the file and load the extracted Metrics into the Time_Series_DB as a Workout_Record
3. WHEN a single Workout_File upload completes successfully, THE WattLocker_API SHALL return a response containing the Workout_Record identifier and Google Drive file reference
4. IF a Workout_File upload fails during Google Drive storage, THEN THE WattLocker_API SHALL return an error response with a descriptive message and not create a Workout_Record
5. IF a Workout_File contains invalid or unparseable data, THEN THE WattLocker_API SHALL return a validation error specifying the parsing failure reason

### Requirement 2: Bulk Workout File Upload

**User Story:** As a cyclist, I want to upload multiple workout files at once, so that I can efficiently import my historical training data.

#### Acceptance Criteria

1. WHEN multiple Workout_Files are submitted via the bulk upload endpoint, THE WattLocker_API SHALL process each file individually, storing it in Google_Drive_Store and loading data into Time_Series_DB
2. THE WattLocker_API SHALL support bulk upload via file selection in WattLocker_Web, where the user selects multiple local files to upload
3. THE WattLocker_API SHALL support bulk upload via a Google Drive inbox folder, where the user places Workout_Files in a configurable inbox folder and triggers ingestion
4. THE path to the Google Drive inbox folder SHALL be a user-configurable setting managed through the Settings page, defaulting to "WattLocker/Inbox" if not specified
5. WHEN bulk ingestion is triggered from the Google Drive inbox folder, THE WattLocker_API SHALL process all supported Workout_Files found in that folder, ingest them through the standard upload flow, and then remove each successfully processed file from the inbox folder
6. WHEN a Bulk_Upload completes, THE WattLocker_API SHALL return a summary response listing successful uploads and any failures with their respective error reasons
7. IF an individual file within a Bulk_Upload fails, THEN THE WattLocker_API SHALL continue processing the remaining files without aborting the entire operation and SHALL leave the failed file in the inbox folder (for Google Drive inbox mode)
8. WHILE a Bulk_Upload is in progress, THE WattLocker_API SHALL track the processing status of each file in the batch

### Requirement 3: Workout File Format Support

**User Story:** As a cyclist, I want to upload workout files in common formats, so that I can import data from any training platform.

#### Acceptance Criteria

1. THE WattLocker_API SHALL accept Workout_Files in FIT format
2. THE WattLocker_API SHALL accept Workout_Files in TCX format
3. THE WattLocker_API SHALL accept Workout_Files in GPX format
4. WHEN a Workout_File is parsed, THE WattLocker_API SHALL extract the following Metrics where available: timestamp, heart rate, power (watts), cadence (rpm), speed, distance, GPS coordinates, and elevation
5. IF a Workout_File is submitted in an unsupported format, THEN THE WattLocker_API SHALL return an error indicating the supported formats

### Requirement 4: Workout File Parser

**User Story:** As a developer, I want a robust parser for workout file formats, so that data is accurately extracted from various file types.

#### Acceptance Criteria

1. WHEN a FIT file is provided, THE Parser SHALL extract all activity records including timestamps, sensor data, and lap summaries
2. WHEN a TCX file is provided, THE Parser SHALL extract all trackpoint elements with their associated metrics
3. WHEN a GPX file is provided, THE Parser SHALL extract all track segments and waypoints with extensions
4. THE Pretty_Printer SHALL format Workout_Record objects back into valid workout file representations
5. FOR ALL valid Workout_Files, parsing then printing then parsing SHALL produce an equivalent Workout_Record object (round-trip property)

### Requirement 5: Google Drive Integration

**User Story:** As a cyclist, I want my workout files stored in my personal Google Drive, so that I always have ownership and access to my raw data.

#### Acceptance Criteria

1. THE WattLocker_API SHALL authenticate with Google Drive using OAuth 2.0 on behalf of the user
2. WHEN a Workout_File is uploaded, THE WattLocker_API SHALL store the file in the user's configured Google Drive storage folder path within the user's Google_Drive_Store
3. THE WattLocker_API SHALL organize files in Google_Drive_Store using a folder structure based on year and month of the workout date
4. WHEN a file is stored in Google_Drive_Store, THE WattLocker_API SHALL record the Google Drive file ID in the corresponding Workout_Record
5. IF Google Drive authentication fails, THEN THE WattLocker_API SHALL return an authentication error and not proceed with the upload

### Requirement 6: Time-Series Database Storage

**User Story:** As a cyclist, I want my workout metrics stored in a time-series database, so that I can efficiently query and analyze my training data over time.

#### Acceptance Criteria

1. WHEN Workout_File data is loaded, THE WattLocker_API SHALL store each Metric as a time-series data point in a MongoDB time-series collection with the workout timestamp as the timeField
2. THE WattLocker_API SHALL tag each Metric data point with the Workout_Record identifier, activity type, and Data_Source as metaFields
3. WHEN a duplicate Workout_File is detected (matching start time and duration), THE WattLocker_API SHALL reject the upload and inform the user of the existing record
4. THE Time_Series_DB SHALL support queries across arbitrary time ranges with sub-second resolution
5. THE WattLocker_API SHALL access all database operations through a repository abstraction layer (interface) so that the underlying database can be replaced with an alternative time-series database (e.g., TimescaleDB, InfluxDB) without modifying business logic
6. THE repository abstraction SHALL define a consistent interface for write, read, query-by-time-range, and delete operations independent of the underlying database technology

### Requirement 7: Workout CRUD Operations

**User Story:** As a cyclist, I want to create, read, update, and delete my workout records, so that I can manage my training history.

#### Acceptance Criteria

1. WHEN a GET request is made to the workouts endpoint with a valid identifier, THE WattLocker_API SHALL return the complete Workout_Record including summary metrics and Google Drive file reference
2. WHEN a GET request is made to the workouts list endpoint, THE WattLocker_API SHALL return a paginated list of Workout_Records sorted by date descending
3. WHEN a PUT request is made with updated workout metadata, THE WattLocker_API SHALL update the Workout_Record and return the modified record
4. WHEN a DELETE request is made for a Workout_Record, THE WattLocker_API SHALL remove the record from Time_Series_DB and optionally remove the file from Google_Drive_Store based on user preference
5. THE WattLocker_API SHALL support filtering workouts by date range, activity type, and Data_Source

### Requirement 8: Strava Integration and Automatic Sync

**User Story:** As a cyclist, I want to connect my Strava account so that new workouts are automatically downloaded and ingested, and I can backfill my historical data without manual file exports.

#### Acceptance Criteria

1. THE WattLocker_API SHALL support OAuth 2.0 authentication with Strava to access the user's activity data
2. WHEN a Strava connection is established, THE WattLocker_API SHALL register a Strava webhook subscription to receive notifications when new activities are created
3. WHEN a new activity webhook event is received from Strava, THE WattLocker_API SHALL automatically download the original workout file (FIT or TCX) via the Strava export endpoint, store it in Google_Drive_Store, and load the parsed data into Time_Series_DB
4. THE WattLocker_API SHALL provide a manual sync endpoint that fetches all activities from Strava that are not already present in the database, enabling historical backfill
5. WHEN downloading workout files from Strava, THE WattLocker_API SHALL prefer the original uploaded file format (FIT/TCX) to preserve full-fidelity device data
6. THE WattLocker_API SHALL handle Strava API rate limits (200 requests per 15 minutes, 2000 per day) gracefully during bulk historical sync by queuing and throttling requests
7. IF a Strava webhook event is received for a workout that already exists in the database (duplicate detection), THEN THE WattLocker_API SHALL skip ingestion and log the event

### Requirement 9: Additional Data Source Integration

**User Story:** As a cyclist, I want the option to connect TrainingPeaks and Garmin Connect accounts, so that I can import workouts from multiple platforms.

#### Acceptance Criteria

1. THE WattLocker_API SHALL support OAuth 2.0 authentication with TrainingPeaks
2. THE WattLocker_API SHALL support integration with Garmin Connect for downloading original workout files
3. WHEN a Data_Source connection is established, THE WattLocker_API SHALL be able to fetch original workout files (FIT/TCX) from that source
4. WHEN workout files are fetched from a Data_Source, THE WattLocker_API SHALL store the original file in Google_Drive_Store and load metrics into Time_Series_DB following the same flow as manual uploads
5. THE Data_Source integration architecture SHALL be extensible to support additional platforms in the future

### Requirement 10: Dashboard and Reporting

**User Story:** As a cyclist, I want a dashboard showing my training overview, so that I can monitor my fitness progress at a glance.

#### Acceptance Criteria

1. THE WattLocker_Web SHALL display a Dashboard with weekly and monthly training summaries including total distance, duration, elevation gain, and Training Stress Score
2. THE WattLocker_Web SHALL display trend charts for key Metrics (power, heart rate, distance) over configurable time periods
3. WHEN a user selects a specific Workout_Record on the Dashboard, THE WattLocker_Web SHALL display detailed workout metrics including a map view of the GPS route
4. THE WattLocker_Web SHALL provide performance comparison tools allowing the user to compare metrics across selected workouts or time periods

### Requirement 11: REST API Design

**User Story:** As a developer, I want a well-structured REST API, so that the frontend and potential third-party integrations can interact with the system reliably.

#### Acceptance Criteria

1. THE WattLocker_API SHALL expose RESTful endpoints following standard HTTP methods (GET, POST, PUT, DELETE) and return appropriate HTTP status codes
2. THE WattLocker_API SHALL return responses in JSON format with consistent envelope structure including data, errors, and pagination metadata
3. THE WattLocker_API SHALL validate all incoming request payloads and return 400-level errors with descriptive messages for invalid requests
4. THE WattLocker_API SHALL implement rate limiting to prevent abuse
5. IF an unexpected server error occurs, THEN THE WattLocker_API SHALL return a 500 response with a correlation ID for debugging without exposing internal details

### Requirement 12: User Authentication

**User Story:** As a user, I want to log in securely, so that my workout data is protected and only accessible to me.

#### Acceptance Criteria

1. THE WattLocker_API SHALL support user registration with email and password
2. THE WattLocker_API SHALL authenticate users and issue JWT (JSON Web Token) access tokens upon successful login
3. THE WattLocker_API SHALL issue a short-lived access token and a longer-lived refresh token to enable seamless session renewal
4. ALL protected API endpoints SHALL require a valid JWT access token in the Authorization header
5. IF a request is made with an expired or invalid token, THEN THE WattLocker_API SHALL return a 401 Unauthorized response
6. THE WattLocker_API SHALL hash passwords using a secure algorithm (bcrypt) before storing them
7. THE WattLocker_Web SHALL provide login and registration pages and manage token storage/refresh transparently

### Requirement 13: User Settings and Administration

**User Story:** As a cyclist, I want a settings page where I can configure my Google Drive paths and connected accounts, so that I can customize how Watt Locker stores and retrieves my data.

#### Acceptance Criteria

1. THE WattLocker_Web SHALL provide a Settings page accessible to authenticated users
2. THE Settings page SHALL allow the user to configure the Google Drive storage folder path (where workout files are archived), defaulting to "WattLocker"
3. THE Settings page SHALL allow the user to configure the Google Drive inbox folder path (for bulk ingestion), defaulting to "WattLocker/Inbox"
4. THE Settings page SHALL display the status of connected Data_Sources (Strava, TrainingPeaks, Garmin Connect) and allow connecting/disconnecting them
5. WHEN a user updates a setting, THE WattLocker_API SHALL persist the change and apply it to all subsequent operations immediately
6. THE WattLocker_API SHALL provide CRUD endpoints for user settings (GET /api/settings, PUT /api/settings)

### Requirement 14: Architecture Separation

**User Story:** As a developer, I want the backend and frontend in separate repositories, so that each can be developed, deployed, and scaled independently.

#### Acceptance Criteria

1. THE WattLocker_API SHALL be deployable as a standalone service independent of WattLocker_Web
2. THE WattLocker_Web SHALL communicate with WattLocker_API exclusively through the documented REST API endpoints
3. THE WattLocker_API SHALL implement CORS configuration to allow requests from the WattLocker_Web domain
4. THE WattLocker_API SHALL provide an OpenAPI specification document describing all available endpoints, request/response schemas, and authentication requirements
