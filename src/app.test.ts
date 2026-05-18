import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';
import request from 'supertest';
import { createApp } from './app';

describe('Express Application', () => {
  let mongoServer: MongoMemoryServer;
  let mongoClient: MongoClient;
  let db: Db;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    mongoClient = new MongoClient(uri);
    await mongoClient.connect();
    db = mongoClient.db();
  });

  afterAll(async () => {
    await mongoClient.close();
    await mongoServer.stop();
  });

  describe('GET /api/health', () => {
    it('should return 200 with status ok', async () => {
      const app = createApp({ db });

      const response = await request(app).get('/api/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
    });

    it('should include correlation ID header in response', async () => {
      const app = createApp({ db });

      const response = await request(app).get('/api/health');

      expect(response.headers['x-correlation-id']).toBeDefined();
      // UUID v4 format
      expect(response.headers['x-correlation-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('should include CORS headers in response', async () => {
      const app = createApp({ db });

      const response = await request(app)
        .get('/api/health')
        .set('Origin', 'http://localhost:5173');

      expect(response.headers['access-control-allow-origin']).toBeDefined();
    });
  });

  describe('Middleware order', () => {
    it('should return 401 for protected routes without auth token', async () => {
      const app = createApp({ db });

      const response = await request(app).get('/api/settings');

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('errors');
      expect(response.body.errors[0]).toHaveProperty('code', 'AUTHENTICATION_ERROR');
      expect(response.body).toHaveProperty('correlationId');
    });

    it('should return 404-style error for unknown routes via error handler', async () => {
      const app = createApp({ db });

      const response = await request(app).get('/api/nonexistent');

      // Express returns 404 for unmatched routes (no custom 404 handler needed)
      expect(response.status).toBe(404);
    });

    it('should parse JSON body for POST requests', async () => {
      const app = createApp({ db });

      const response = await request(app)
        .post('/api/auth/register')
        .send({ email: 'test@example.com', password: 'password123' })
        .set('Content-Type', 'application/json');

      // Should get 201 (successful registration) — proves body parsing works
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('data');
      expect(response.body.data).toHaveProperty('accessToken');
    });
  });
});
