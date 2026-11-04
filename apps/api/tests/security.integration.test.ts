import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { beforeAll, afterAll, beforeEach, afterEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { AuthService } from '../src/modules/auth/service.js';
import { sql } from '@dota/db';
import { ownerReadRoutes, ownerWriteRoutes, routeExample } from '../../../tests/helpers/security-routes.js';
let database: Awaited<ReturnType<typeof testDatabase>>, app: FastifyInstance, logs: string, password: string, providerCalls: number;
const marker = 'synthetic-private-url-marker', origin = 'http://localhost:5173';
beforeAll(async () => {
  database = await testDatabase(); password = randomBytes(24).toString('base64url');
  await new AuthService(database.db).provision('synthetic-security-owner', password);
}, 30000);
beforeEach(async () => {
  logs = ''; providerCalls = 0;
  await sql`DELETE FROM auth_login_budget`.execute(database.db);
  const stream = new Writable({ write(chunk, _encoding, callback) { logs += String(chunk); callback(); } });
  app = await buildApp(readConfig({ DATABASE_URL: database.url }), { db: database.db, logger: { stream },
    pandascoreFetch: async () => { providerCalls++; throw Error('Unexpected provider call in security test'); } });
});
afterEach(async () => {
  try {
    expect(providerCalls).toBe(0);
    expect(logs).not.toContain(marker); expect(logs).not.toContain(password);
    for (const table of ['scenarios', 'prediction_runs', 'v1_runtime_snapshots', 'v1_journal_reports', 'model_activation_events',
      'v1_schedule_targets', 'v1_schedule_result_bindings', 'v1_forecast_outcome_revisions', 'upcoming_source_observations', 'history_refresh_runs'])
      expect((await sql`SELECT 1 FROM ${sql.table(table)}`.execute(database.db)).rows, table).toHaveLength(0);
  } finally { await app?.close(); }
});
afterAll(async () => { await database?.close(); }, 30000);
test('router malformed-URL rejection is sanitized and no-store before owner hooks', async () => {
  const response = await app.inject({ url: '/api/v1/teams/' + marker + '%E0%A4%A' });
  expect(response.statusCode).toBe(400);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).not.toContain(marker); expect(response.body).not.toContain('%E0');
  expect(response.json().error.code).toBe('VALIDATION_ERROR');
});
test('router maximum-parameter rejection is sanitized and no-store before owner hooks', async () => {
  const response = await app.inject({ url: '/api/v1/teams/' + marker + 'x'.repeat(200) });
  expect(response.statusCode).toBe(414); expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).not.toContain(marker); expect(response.json().error.code).toBe('URI_TOO_LONG');
});
test('request logs retain correlation without raw known/unknown URL parameters or query', async () => {
  await app.inject({ url: '/api/v1/teams/' + marker + '?private_query=' + marker });
  await app.inject({ url: '/api/v1/unregistered/' + marker });
  expect(logs).not.toContain(marker); expect(logs).toContain('reqId');
  expect(logs).toContain('/api/v1/teams/:id');
});
async function owner() {
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin },
    payload: { login: 'synthetic-security-owner', password } });
  expect(login.statusCode).toBe(200);
  const cookies = login.headers['set-cookie'];
  return { cookie: (Array.isArray(cookies) ? cookies : [cookies ?? '']).map(c => c.split(';')[0]).join('; '), csrf: login.json().csrfToken as string };
}
test('all 49 registered private method/path routes and 31 HEAD variants reject anonymous requests', async () => {
  expect(ownerReadRoutes).toHaveLength(31); expect(ownerWriteRoutes).toHaveLength(18);
  for (const path of ownerReadRoutes) for (const method of ['GET', 'HEAD'] as const) {
    expect(app.hasRoute({ method, url: path }), method + ' ' + path).toBe(true);
    const result = await app.inject({ method, url: routeExample(path) });
    expect(result.statusCode, method + ' ' + path).toBe(401); expect(result.headers['cache-control']).toBe('no-store');
  }
  for (const route of ownerWriteRoutes) {
    expect(app.hasRoute(route), route.url).toBe(true);
    const result = await app.inject({ ...route, url: routeExample(route.url), payload: {} });
    expect(result.statusCode, route.method + ' ' + route.url).toBe(401); expect(result.headers['cache-control']).toBe('no-store');
  }
  expect((await app.inject('/health')).statusCode).toBe(200);
});
test('all 18 private mutation routes reject absent/wrong CSRF and absent/foreign/cross-site Origin before handlers', async () => {
  const { cookie, csrf } = await owner();
  for (const route of ownerWriteRoutes) for (const headers of [
    { cookie, origin }, { cookie, origin, 'x-csrf-token': 'wrong' },
    { cookie, origin: 'https://foreign.example', 'x-csrf-token': csrf },
    { cookie, 'x-csrf-token': csrf },
    { cookie, origin, 'x-csrf-token': csrf, 'sec-fetch-site': 'cross-site' },
  ]) {
    const result = await app.inject({ ...route, url: routeExample(route.url), headers, payload: {} });
    expect(result.statusCode, route.method + ' ' + route.url).toBe(403); expect(result.headers['cache-control']).toBe('no-store');
  }
  expect((await app.inject({ url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(200);
});
test('errors at parsing, validation, lookup and handler boundaries stay sanitized and no-store', async () => {
  app.get('/api/v1/security-error-probe', async () => { throw Error(marker); });
  const { cookie, csrf } = await owner(), headers = { cookie, origin, 'x-csrf-token': csrf };
  const responses = [
    await app.inject({ method: 'POST', url: '/api/v1/scenarios', headers, payload: { ownerId: marker } }),
    await app.inject({ method: 'POST', url: '/api/v1/scenarios', headers: { ...headers, 'content-type': 'application/json' }, payload: '{"private":"' + marker }),
    await app.inject({ method: 'POST', url: '/api/v1/scenarios', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify({ private: marker.repeat(500) }) }),
    await app.inject({ method: 'POST', url: '/api/v1/scenarios', headers: { ...headers, 'content-type': 'application/x-private' }, payload: marker }),
    await app.inject({ url: '/api/v1/unregistered/' + marker, headers: { cookie } }),
    await app.inject({ url: '/api/v1/security-error-probe', headers: { cookie } }),
  ];
  expect(responses.map(r => r.statusCode)).toEqual([400, 400, 413, 415, 404, 500]);
  for (const result of responses) { expect(result.headers['cache-control']).toBe('no-store'); expect(result.body).not.toContain(marker); }
  for (const value of [marker, password, cookie, csrf]) expect(logs).not.toContain(value);
});
