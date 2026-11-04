import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { V1ModelReadinessSchema } from '@dota/contracts';
import { V1ModelRegistry, sql } from '@dota/db';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { AuthService } from '../src/modules/auth/service.js';
let database: Awaited<ReturnType<typeof testDatabase>>, app: FastifyInstance, cookie: string, providerCalls: number;
const url = '/api/v1/models/readiness';
const get = (path = url) => app.inject({ url: path, headers: { cookie } });
beforeEach(async () => {
  database = await testDatabase(); providerCalls = 0;
  const password = randomBytes(24).toString('base64url');
  await new AuthService(database.db).provision('synthetic-readiness', password);
  app = await buildApp(readConfig({ DATABASE_URL: database.url }), { db: database.db, logger: false,
    pandascoreFetch: async () => { providerCalls++; throw Error('Unexpected provider call'); } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://localhost:5173' },
    payload: { login: 'synthetic-readiness', password } });
  const cookies = login.headers['set-cookie']; cookie = (Array.isArray(cookies) ? cookies : [cookies ?? '']).map(c => c.split(';')[0]).join('; ');
}, 30000);
afterEach(async () => {
  vi.restoreAllMocks();
  try {
    expect(providerCalls).toBe(0);
    for (const table of ['prediction_runs', 'model_activation_events', 'scenarios', 'v1_runtime_snapshots', 'v1_model_artifacts'])
      expect((await sql`SELECT 1 FROM ${sql.table(table)}`.execute(database.db)).rows).toHaveLength(0);
  } finally { await app?.close(); await database?.close(); }
}, 30000);
test('requires an owner, rejects parameter overrides and reads the real empty registry without writing', async () => {
  expect((await app.inject({ url })).statusCode).toBe(401);
  expect((await app.inject({ url, headers: { cookie: 'dota_owner_session=invalid' } })).statusCode).toBe(401);
  const response = await get(); expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(V1ModelReadinessSchema.parse(response.json())).toMatchObject({ stage: 'pre_match', status: 'unavailable', reason: 'NO_ACTIVE_MODEL',
    modelId: null, reportSha256: null, teamAWinProbability: null });
  expect(Date.parse(response.json().checkedAt)).not.toBeNaN();
  for (const query of ['?modelId=' + randomUUID(), '?stage=post_draft', '?activate=true']) expect((await get(url + query)).statusCode).toBe(400);
});
test('projects synthetic eligible and invalid registry results without issuing probability or exposing raw bytes', async () => {
  // Contract doubles only: no synthetic model is activated or described as a real release pass.
  const modelId = randomUUID(), spy = vi.spyOn(V1ModelRegistry.prototype, 'readiness');
  spy.mockResolvedValueOnce({ status: 'model_eligible', modelId, reportSha256: 'a'.repeat(64), teamAWinProbability: null });
  expect(V1ModelReadinessSchema.parse((await get()).json())).toMatchObject({ status: 'model_eligible', reason: null, modelId, teamAWinProbability: null });
  spy.mockResolvedValueOnce({ status: 'unavailable', reason: 'ACTIVE_MODEL_EVIDENCE_INVALID', modelId, teamAWinProbability: null });
  expect(V1ModelReadinessSchema.parse((await get()).json())).toMatchObject({ status: 'unavailable', reason: 'ACTIVE_MODEL_EVIDENCE_INVALID', modelId, reportSha256: null });
  spy.mockRejectedValueOnce(Error('synthetic-private-artifact-and-token'));
  const failed = await get(); expect(failed.statusCode).toBe(500); expect(failed.body).not.toContain('synthetic-private');
  expect(failed.json().error.code).toBe('INTERNAL_ERROR');
});
test('bounds registry polling and retains no-store on rate rejection', async () => {
  for (let i = 0; i < 20; i++) expect((await get()).statusCode).toBe(200);
  const limited = await get(); expect(limited.statusCode).toBe(429); expect(limited.headers['retry-after']).toBeDefined();
  expect(limited.headers['cache-control']).toBe('no-store');
});
test('admits only one registry read and releases admission after a failed read', async () => {
  let started = () => {}, release = () => {};
  const entered = new Promise<void>(r => started = r), gate = new Promise<void>(r => release = r);
  const spy = vi.spyOn(V1ModelRegistry.prototype, 'readiness').mockImplementationOnce(async () => {
    started(); await gate; throw Error('synthetic-private');
  });
  const first = get().then(r => r);
  try {
    await entered;
    const busy = await get(); expect(busy.statusCode).toBe(429); expect(busy.headers['retry-after']).toBe('1');
    expect(busy.json().error.code).toBe('MODEL_CHECK_BUSY'); expect(spy).toHaveBeenCalledTimes(1);
    release(); expect((await first).statusCode).toBe(500);
    spy.mockRestore(); expect((await get()).statusCode).toBe(200);
  } finally { release(); await first; }
});
