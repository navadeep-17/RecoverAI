import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';

describe('API Health & Readiness Endpoints', () => {
  const app = buildServer();

  it('GET /health returns 200 with status ok and valid shape', async () => {
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

  it('GET /ready returns valid status and readiness state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ready',
    });

    expect([200, 503]).toContain(res.statusCode);
    const body = JSON.parse(res.payload);
    expect(typeof body.ready).toBe('boolean');
    expect(typeof body.database).toBe('boolean');
  });

  it('Injects x-correlation-id header on responses', async () => {
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
