import { afterAll, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
// Public liveness and unauthenticated rejection do not open a DB connection.
const app = await buildApp(readConfig({ DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/unavailable' }), { logger: false });
afterAll(async () => app.close());
test('GET /health returns a status', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ status: 'ok' });
});
test('private endpoints fail closed without a cookie even if DB is unavailable', async () => {
  expect((await app.inject('/api/v1/auth/me')).statusCode).toBe(401);
});
