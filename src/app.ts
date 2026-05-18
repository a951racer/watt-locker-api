import express, { Express } from 'express';
import { Db } from 'mongodb';

// Middleware
import { correlationIdMiddleware } from './middleware/correlationId';
import { createCorsMiddleware } from './middleware/cors';
import { generalLimiter, authLimiter } from './middleware/rateLimiter';
import { createAuthMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';

// Routes
import { createHealthRouter } from './routes/health';
import { createAuthRouter } from './routes/auth';
import { createStravaRouter } from './routes/strava';
import { createWebhookRouter } from './routes/webhooks';
import { createSettingsRouter } from './routes/settings';
import { createWorkoutsRouter } from './routes/workouts';
import { createGoogleAuthRouter } from './routes/googleAuth';

// Services
import { AuthService } from './services/authService';
import { SettingsService } from './services/settingsService';
import { StravaSyncService } from './services/stravaSyncService';
import { WorkoutService } from './services/workoutService';
import { UploadService } from './services/uploadService';

// Repositories
import { MongoUserRepository } from './repositories/userRepository';
import { MongoSettingsRepository } from './repositories/settingsRepository';
import { MongoWorkoutRepository } from './repositories/workoutRepository';

// Parsers & Storage
import { DefaultParserFactory } from './parsers/parserFactory';
import { GpxFileParser } from './parsers/gpxParser';
import { TcxFileParser } from './parsers/tcxParser';
import { FitFileParser } from './parsers/fitParser';
import { FileStorageAdapter } from './storage/googleDriveAdapter';

/**
 * Dependencies that can be injected into createApp for testing.
 * When not provided, real implementations are created from the database.
 */
export interface AppDependencies {
  db: Db;
  fileStorageAdapter?: FileStorageAdapter;
}

/**
 * Creates and configures the Express application with all middleware and routes.
 * Accepts a database instance and optional overrides for testing.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();

  // --- Repositories ---
  const userRepository = new MongoUserRepository(deps.db);
  const settingsRepository = new MongoSettingsRepository(deps.db);
  const workoutRepository = new MongoWorkoutRepository(deps.db);

  // --- Services ---
  const authService = new AuthService(userRepository);
  const settingsService = new SettingsService(settingsRepository);
  const parserFactory = new DefaultParserFactory();
  parserFactory.registerParser('gpx', new GpxFileParser());
  parserFactory.registerParser('tcx', new TcxFileParser());
  parserFactory.registerParser('fit', new FitFileParser());

  // File storage adapter — use injected mock or a placeholder for production
  // In production, the Google Drive adapter is configured per-user via OAuth tokens,
  // so we use a no-op adapter at the app level. Per-user adapters are created in services.
  const fileStorageAdapter: FileStorageAdapter = deps.fileStorageAdapter ?? createNoOpStorageAdapter();

  const uploadService = new UploadService(
    parserFactory,
    workoutRepository,
    fileStorageAdapter,
    settingsService,
  );

  const workoutService = new WorkoutService(workoutRepository, fileStorageAdapter);

  const stravaSyncService = new StravaSyncService(
    settingsService,
    undefined, // uses default StravaHttpClient
    workoutRepository,
    uploadService,
  );

  // --- Auth Middleware ---
  const authMiddleware = createAuthMiddleware(authService);

  // --- Global Middleware (order matters) ---
  app.use(correlationIdMiddleware);
  app.use(createCorsMiddleware());
  app.use(generalLimiter);
  app.use(express.json({ limit: '50mb' }));

  // --- Routes ---
  // Health check — no auth required
  app.use('/api/health', createHealthRouter());

  // Auth routes — stricter rate limit, no JWT auth
  app.use('/api/auth', authLimiter, createAuthRouter(authService));

  // Strava OAuth routes — mounted under /api/auth/strava
  app.use('/api/auth/strava', createStravaRouter(stravaSyncService, authMiddleware));

  // Google Drive OAuth routes — mounted under /api/auth/google
  app.use('/api/auth/google', createGoogleAuthRouter(settingsService, authMiddleware));

  // Webhook routes — no auth required (Strava calls these directly)
  app.use('/api/webhooks', createWebhookRouter(stravaSyncService));

  // Settings routes — JWT auth applied inside the router
  app.use('/api/settings', createSettingsRouter(settingsService, authMiddleware));

  // Workout routes — JWT auth applied inside the router
  app.use('/api/workouts', createWorkoutsRouter(workoutService, uploadService, authMiddleware));

  // --- Error Handler (must be last) ---
  app.use(errorHandler);

  return app;
}

/**
 * Creates a no-op file storage adapter for cases where Google Drive
 * is not configured (e.g., development without OAuth setup).
 * All operations throw an error indicating Drive is not configured.
 */
function createNoOpStorageAdapter(): FileStorageAdapter {
  const notConfigured = () => {
    throw new Error('Google Drive storage adapter is not configured. Please connect Google Drive in settings.');
  };

  return {
    store: notConfigured,
    retrieve: notConfigured,
    delete: notConfigured,
    listFiles: async () => [],
    removeFromFolder: notConfigured,
  };
}
