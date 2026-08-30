import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { composeApiReviewService } from '../src/runtime.js';

describe('ordinary API runtime composition', () => {
  const apps: ReturnType<typeof buildServer>[] = [];

  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

  it('registers review routes with the real HumanReviewService graph', async () => {
    const reviewService = composeApiReviewService({ NODE_ENV: 'test', AI_PROVIDER: 'mock' } as any);
    const app = buildServer({ reviewService, checkDbConnection: async () => true });
    apps.push(app);
    await app.ready();
    expect(app.printRoutes()).toContain('views (GET, HEAD)');
    expect(await app.inject({ method: 'GET', url: '/reviews' })).toMatchObject({ statusCode: 401 });
  });
});
