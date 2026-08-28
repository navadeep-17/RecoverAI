import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';

describe('API Health & Readiness Endpoints', () => {
  it('GET /health returns 200 with status ok and valid shape', async () => {
    const app = buildServer({ checkDbConnection: async () => true });
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('recoverai-api');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.timestamp).toBe('string');
  });

  it('GET /ready returns HTTP 200 and ready=true when database is healthy', async () => {
    const app = buildServer({ checkDbConnection: async () => true });
    const res = await app.inject({
      method: 'GET',
      url: '/ready',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ready).toBe(true);
    expect(body.database).toBe(true);
    expect(typeof body.timestamp).toBe('string');
  });

  it('GET /ready returns HTTP 503 and ready=false when database is unhealthy', async () => {
    const app = buildServer({ checkDbConnection: async () => false });
    const res = await app.inject({
      method: 'GET',
      url: '/ready',
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.payload);
    expect(body.ready).toBe(false);
    expect(body.database).toBe(false);
    expect(typeof body.timestamp).toBe('string');
  });

  it('Injects x-correlation-id header on responses', async () => {
    const app = buildServer({ checkDbConnection: async () => true });
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-correlation-id': 'custom-req-id-12345',
      },
    });

    expect(res.headers['x-correlation-id']).toBe('custom-req-id-12345');
  });
});
