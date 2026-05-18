import express from 'express';
import request from 'supertest';
import { createCorsMiddleware } from './cors';

// Mock the config module to control CORS_ORIGIN in tests
jest.mock('../config/env', () => ({
  config: {
    cors: {
      origin: 'http://localhost:5173',
    },
  },
}));

function createTestApp() {
  const app = express();
  app.use(createCorsMiddleware());
  app.get('/test', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('CORS Middleware', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
  });

  it('should set Access-Control-Allow-Origin for allowed origin', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'http://localhost:5173');

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('should restrict origin to the configured value', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'http://evil.com');

    // The cors package with a string origin always reflects the configured origin,
    // but browsers enforce the mismatch and block the response.
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('should handle preflight OPTIONS requests', async () => {
    const res = await request(app)
      .options('/test')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization,Content-Type');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-methods']).toContain('PUT');
    expect(res.headers['access-control-allow-methods']).toContain('DELETE');
  });

  it('should allow Authorization and Content-Type headers', async () => {
    const res = await request(app)
      .options('/test')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'Authorization,Content-Type');

    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    expect(res.headers['access-control-allow-headers']).toContain('Content-Type');
  });

  it('should allow credentials', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'http://localhost:5173');

    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});
