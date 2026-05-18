import { MongoClient } from 'mongodb';
import { config } from './config/env';
import { initializeCollections } from './config/database';
import { createApp } from './app';

/**
 * Application entry point.
 * Connects to MongoDB, initializes collections, and starts the Express server.
 */
async function main(): Promise<void> {
  const mongoClient = new MongoClient(config.mongo.uri);

  try {
    // Connect to MongoDB
    console.log('Connecting to MongoDB...');
    await mongoClient.connect();
    console.log('Connected to MongoDB successfully');

    const db = mongoClient.db();

    // Initialize time-series collections and indexes
    await initializeCollections(db);
    console.log('Database collections initialized');

    // Create and start the Express application
    const app = createApp({ db });

    const server = app.listen(config.port, () => {
      console.log(`WattLocker API server running on port ${config.port}`);
      console.log(`Environment: ${config.nodeEnv}`);
    });

    // Graceful shutdown handling
    const shutdown = async (signal: string) => {
      console.log(`\n${signal} received. Shutting down gracefully...`);

      server.close(() => {
        console.log('HTTP server closed');
      });

      try {
        await mongoClient.close();
        console.log('MongoDB connection closed');
      } catch (err) {
        console.error('Error closing MongoDB connection:', err);
      }

      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error('Failed to start server:', error);
    await mongoClient.close();
    process.exit(1);
  }
}

main();
