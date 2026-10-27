import { afterAll, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
const app = await buildApp();
afterAll(async () => app.close());
test('GET /health returns a status', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ status: 'ok' });
});
