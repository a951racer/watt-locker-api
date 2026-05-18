import express from 'express';
import request from 'supertest';
import { createHealthRouter } from './health';

function createTestApp() {
  const app = express();
  app.use('/api/health', createHealthRouter());
  return app;
}

describe('Health Route', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
  });

  describe('GET /api/health', () => {
    it('should return 200 with status ok', async () => {
      const res = await request(app).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('should return a valid ISO timestamp', async () => {
      const res = await request(app).get('/api/health');

      expect(res.body.timestamp).toBeDefined();
      const parsed = new Date(res.body.timestamp);
      expect(parsed.toISOString()).toBe(res.body.timestamp);
    });

    it('should not require authentication', async () => {
      // No Authorization header sent
      const res = await request(app).get('/api/health');

      expect(res.status).toBe(200);
    });
  });
});
